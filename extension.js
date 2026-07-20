import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UPDATE_INTERVAL_MS = 2500;
const ROTATION_INTERVAL_MS = 16; // ~60 fps
const MAX_RPM = 6000;
const MAX_DEGREES_PER_FRAME = 30;
const SMOOTHING_FACTOR = 0.05;

const FanIndicator = GObject.registerClass(
class FanIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'Dynamic Fan & Temp Indicator');

        this._box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            vertical: false,
        });
        this.add_child(this._box);

        const iconPath = extensionPath + '/fan-symbolic.svg';
        this._gicon = Gio.icon_new_for_string(iconPath);

        // State tracking for smooth fan rotation animation
        this._fanStates = {};
        // References to UI elements for fast value updates without rebuild
        this._uiFans = [];
        this._uiTemps = [];
        this._panelTempsLabel = null;
        // Fingerprint of discovered hardware to detect topology changes
        this._currentFingerprint = '';
        this._uiInitialized = false;

        this._updateLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
            this._updateStats();
            return GLib.SOURCE_CONTINUE;
        });

        this._rotationLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ROTATION_INTERVAL_MS, () => {
            this._rotateIcons();
            return GLib.SOURCE_CONTINUE;
        });

        this._updateStats();
    }

    // Run a command asynchronously and return its stdout as a string.
    // Rejects on spawn failure or if the process exits with an error.
    _execAsync(argv) {
        return new Promise((resolve, reject) => {
            try {
                const proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
                proc.communicate_utf8_async(null, null, (obj, res) => {
                    try {
                        const [ok, stdout] = obj.communicate_utf8_finish(res);
                        if (ok)
                            resolve(stdout ?? '');
                        else
                            reject(new Error('Process failed'));
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    async _updateStats() {
        const fans = [];
        const temps = [];
        const seenKeys = new Set();

        const addFan = f => {
            if (!seenKeys.has(`fan:${f.key}`)) {
                seenKeys.add(`fan:${f.key}`);
                fans.push(f);
            }
        };
        const addTemp = t => {
            if (!seenKeys.has(`temp:${t.key}`)) {
                seenKeys.add(`temp:${t.key}`);
                temps.push(t);
            }
        };

        // ── 1. Direct hwmon sysfs read ──────────────────────────────────
        // Works with whatever kernel drivers are loaded, independent of
        // any userspace lm-sensors configuration. Uses a single shell
        // command to avoid spawning dozens of subprocesses.
        try {
            const hwmon = await this._readHwmonDirect();
            hwmon.fans.forEach(addFan);
            hwmon.temps.forEach(addTemp);
        } catch (e) {
            console.warn(`Fan Indicator: hwmon read failed: ${e.message}`);
        }

        // ── 2. lm-sensors JSON output ───────────────────────────────────
        // Second pass: can provide friendlier chip/feature labels on
        // systems where sensors-detect has been run. Results are deduped
        // against the hwmon pass above.
        try {
            const sensorsJson = await this._execAsync(['sensors', '-j']);
            if (sensorsJson) {
                const parsed = this._parseSensorsJson(sensorsJson);
                parsed.fans.forEach(addFan);
                parsed.temps.forEach(addTemp);
            }
        } catch (_e) {
            // sensors binary missing or failed — not a problem, hwmon is
            // the primary source.
        }

        // ── 3. Proprietary NVIDIA GPU sensors ───────────────────────────
        try {
            const nvidiaOut = await this._execAsync([
                'nvidia-smi',
                '--query-gpu=name,temperature.gpu,fan.speed',
                '--format=csv,noheader',
            ]);
            if (nvidiaOut) {
                nvidiaOut.trim().split('\n').forEach((line, index) => {
                    const parts = line.split(',').map(s => s.trim());
                    if (parts.length < 3) return;

                    const gpuName = parts[0].replace('NVIDIA GeForce ', '');
                    const tempVal = parseInt(parts[1], 10);
                    const fanStr = parts[2].replace('%', '').trim();

                    if (fanStr !== '[Not Supported]' && !isNaN(parseInt(fanStr, 10))) {
                        addFan({
                            key: `nvidia_fan_${index}`,
                            label: `${gpuName} Fan`,
                            value: parseInt(fanStr, 10),
                            isPercentage: true,
                        });
                    }

                    if (!isNaN(tempVal)) {
                        addTemp({
                            key: `nvidia_temp_${index}`,
                            label: gpuName,
                            value: tempVal,
                        });
                    }
                });
            }
        } catch (_e) {
            // nvidia-smi missing or failed — expected when no NVIDIA GPU.
        }

        // ── Decide whether to rebuild or just update values ─────────────
        const fingerprint =
            fans.map(f => f.key).join(',') + '|' + temps.map(t => t.key).join(',');

        if (fingerprint !== this._currentFingerprint) {
            this._currentFingerprint = fingerprint;
            this._rebuildUi(fans, temps);
        } else {
            this._updateUiValues(fans, temps);
        }
    }

    // Reads /sys/class/hwmon/hwmon*/ using a single consolidated shell
    // command. Each hwmon directory represents a kernel driver (CPU thermal,
    // EC/ACPI vendor drivers, GPU drivers, etc.).
    async _readHwmonDirect() {
        const fans = [];
        const temps = [];

        // One shell invocation that walks all hwmon dirs and prints a
        // structured, easy-to-parse record per sensor value:
        //   TYPE|chipName|index|label|value
        const script = `
for dir in /sys/class/hwmon/hwmon*; do
  [ -d "$dir" ] || continue
  chip=$(cat "$dir/name" 2>/dev/null || basename "$dir")
  for f in "$dir"/fan*_input; do
    [ -f "$f" ] || continue
    idx=$(echo "$f" | grep -oP 'fan\\K[0-9]+')
    val=$(cat "$f" 2>/dev/null) || continue
    lbl=$(cat "$dir/fan${idx}_label" 2>/dev/null || echo "fan${idx}")
    echo "FAN|$chip|$idx|$lbl|$val"
  done
  for f in "$dir"/temp*_input; do
    [ -f "$f" ] || continue
    idx=$(echo "$f" | grep -oP 'temp\\K[0-9]+')
    val=$(cat "$f" 2>/dev/null) || continue
    lbl=$(cat "$dir/temp${idx}_label" 2>/dev/null || echo "temp${idx}")
    echo "TEMP|$chip|$idx|$lbl|$val"
  done
done`;

        let output;
        try {
            output = await this._execAsync(['sh', '-c', script]);
        } catch (_e) {
            return {fans, temps};
        }
        if (!output) return {fans, temps};

        for (const line of output.trim().split('\n')) {
            if (!line) continue;
            const [type, chip, idx, label, rawValue] = line.split('|');
            const value = parseInt(rawValue, 10);
            if (isNaN(value)) continue;

            if (type === 'FAN') {
                fans.push({
                    key: `hwmon_${chip}_fan${idx}`,
                    label: `${label} (${chip})`,
                    value,
                    isPercentage: false,
                });
            } else if (type === 'TEMP') {
                temps.push({
                    key: `hwmon_${chip}_temp${idx}`,
                    label: `${label} (${chip})`,
                    value: Math.round(value / 1000),
                });
            }
        }

        return {fans, temps};
    }

    _parseSensorsJson(jsonStr) {
        const fans = [];
        const temps = [];

        try {
            const data = JSON.parse(jsonStr);

            for (const [chip, chipData] of Object.entries(data)) {
                const friendlyChip = chip.split('-')[0];

                for (const [feature, featureData] of Object.entries(chipData)) {
                    if (typeof featureData !== 'object' || featureData === null)
                        continue;

                    for (const [subFeature, value] of Object.entries(featureData)) {
                        if (!subFeature.endsWith('_input')) continue;

                        if (subFeature.includes('fan')) {
                            fans.push({
                                key: `${chip}_${feature}`,
                                label: feature.startsWith('fan')
                                    ? `${feature} (${friendlyChip})`
                                    : feature,
                                value: Math.round(value),
                                isPercentage: false,
                            });
                        }

                        if (subFeature.includes('temp')) {
                            temps.push({
                                key: `${chip}_${feature}`,
                                label: feature.startsWith('temp')
                                    ? `${feature} (${friendlyChip})`
                                    : feature,
                                value: Math.round(value),
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Fan Indicator: JSON parse error: ${e.message}`);
        }

        return {fans, temps};
    }

    // ── UI construction ─────────────────────────────────────────────────

    _rebuildUi(fansData, tempsData) {
        // Tear down existing UI
        this._box.destroy_all_children();
        this.menu.removeAll();
        this._uiFans = [];
        this._uiTemps = [];
        this._panelTempsLabel = null;

        // Purge stale fan animation states
        const activeFanKeys = new Set(fansData.map(f => f.key));
        for (const key of Object.keys(this._fanStates)) {
            if (!activeFanKeys.has(key))
                delete this._fanStates[key];
        }

        // Nothing found at all
        if (fansData.length === 0 && tempsData.length === 0) {
            this._showFallbackNotice();
            return;
        }

        // ── Fan entries ─────────────────────────────────────────────────
        fansData.forEach((fan, index) => {
            const unit = fan.isPercentage ? '%' : ' RPM';

            // Initialise animation state if new
            if (!this._fanStates[fan.key]) {
                this._fanStates[fan.key] = {
                    currentRpm: 0,
                    targetRpm: fan.value,
                    angle: 0,
                    iconActor: null,
                    isPercentage: fan.isPercentage,
                };
            }
            this._fanStates[fan.key].targetRpm = fan.value;

            // Popup menu row (always added)
            const menuItem = new PopupMenu.PopupMenuItem(
                `${fan.label}: ${fan.value}${unit}`);
            this.menu.addMenuItem(menuItem);

            const fanUi = {
                key: fan.key,
                label: fan.label,
                menuItem,
                hasPanelPresence: false,
                unit,
                panelLabel: null,
            };

            // Top-bar presence: show the first two fans with rotating icons
            if (index < 2) {
                const icon = new St.Icon({
                    gicon: this._gicon,
                    style_class: 'system-status-icon',
                });
                icon.set_pivot_point(0.5, 0.5);

                const label = new St.Label({
                    text: `${fan.value}${unit}`,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-left: 4px; margin-right: 12px; font-weight: bold;',
                });

                this._box.add_child(icon);
                this._box.add_child(label);

                this._fanStates[fan.key].iconActor = icon;
                fanUi.panelLabel = label;
                fanUi.hasPanelPresence = true;
            }

            this._uiFans.push(fanUi);
        });

        // Informational row when temps exist but fans were not detected
        if (fansData.length === 0 && tempsData.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'ℹ️ No fan RPM exposed by this hardware'));
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // ── Temperature entries ─────────────────────────────────────────
        if (fansData.length > 0 && tempsData.length > 0)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const panelTempsList = [];
        tempsData.forEach((temp, index) => {
            const menuItem = new PopupMenu.PopupMenuItem(
                `${temp.label}: ${temp.value}°C`);
            this.menu.addMenuItem(menuItem);

            const tempUi = {
                key: temp.key,
                label: temp.label,
                menuItem,
                hasPanelPresence: index < 4,
            };

            if (index < 4)
                panelTempsList.push(`${temp.value}°C`);

            this._uiTemps.push(tempUi);
        });

        // Compact temperature readout in the top bar
        if (panelTempsList.length > 0) {
            this._panelTempsLabel = new St.Label({
                text: `🔥 ${panelTempsList.join(' | ')}`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 4px; font-weight: bold; color: #ff5500;',
            });
            this._box.add_child(this._panelTempsLabel);
        }

        // If the panel ended up completely empty, add a marker icon so the
        // indicator remains visible and clickable.
        if (this._box.get_n_children() === 0) {
            const marker = new St.Icon({
                gicon: this._gicon,
                style_class: 'system-status-icon',
            });
            this._box.add_child(marker);
        }

        this._uiInitialized = true;
    }

    _updateUiValues(fansData, tempsData) {
        for (const fan of fansData) {
            if (this._fanStates[fan.key])
                this._fanStates[fan.key].targetRpm = fan.value;

            const ui = this._uiFans.find(f => f.key === fan.key);
            if (!ui) continue;
            ui.menuItem.label.text = `${ui.label}: ${fan.value}${ui.unit}`;
            if (ui.hasPanelPresence && ui.panelLabel)
                ui.panelLabel.set_text(`${fan.value}${ui.unit}`);
        }

        const panelTempsList = [];
        for (const temp of tempsData) {
            const ui = this._uiTemps.find(t => t.key === temp.key);
            if (!ui) continue;
            ui.menuItem.label.text = `${ui.label}: ${temp.value}°C`;
            if (ui.hasPanelPresence)
                panelTempsList.push(`${temp.value}°C`);
        }

        if (this._panelTempsLabel && panelTempsList.length > 0)
            this._panelTempsLabel.set_text(`🔥 ${panelTempsList.join(' | ')}`);
    }

    // ── Animation ───────────────────────────────────────────────────────

    _rotateIcons() {
        if (!this._uiInitialized) return;

        for (const key in this._fanStates) {
            const state = this._fanStates[key];
            if (!state.iconActor) continue;

            state.currentRpm +=
                (state.targetRpm - state.currentRpm) * SMOOTHING_FACTOR;

            const maxVal = state.isPercentage ? 100 : MAX_RPM;
            const threshold = state.isPercentage ? 5 : 50;

            if (state.currentRpm >= threshold) {
                const ratio = Math.min(state.currentRpm / maxVal, 1.0);
                state.angle = (state.angle + ratio * MAX_DEGREES_PER_FRAME) % 360;
                state.iconActor.rotation_angle_z = state.angle;
            }
        }
    }

    // ── Fallback when nothing is detected ───────────────────────────────

    _showFallbackNotice() {
        this._box.destroy_all_children();
        this.menu.removeAll();

        const errorLabel = new St.Label({
            text: '⚠️ No Sensors',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; color: #ff3333;',
        });
        this._box.add_child(errorLabel);

        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            'No hwmon sensors detected. Try installing lm-sensors and running "sensors-detect".'));

        this._uiInitialized = false;
    }

    destroy() {
        if (this._updateLoopId) {
            GLib.Source.remove(this._updateLoopId);
            this._updateLoopId = null;
        }
        if (this._rotationLoopId) {
            GLib.Source.remove(this._rotationLoopId);
            this._rotationLoopId = null;
        }
        super.destroy();
    }
});

export default class FanIconExtension extends Extension {
    enable() {
        this._indicator = new FanIndicator(this.dir.get_path());
        Main.panel.addToStatusArea('fan-indicator', this._indicator, 1, 'left');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
