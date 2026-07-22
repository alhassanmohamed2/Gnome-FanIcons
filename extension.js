import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ── Tuning constants ────────────────────────────────────────────────────
const UPDATE_INTERVAL_MS = 3000;   // Poll sensors every 3s
const ROTATION_INTERVAL_MS = 16;   // ~60 fps for ultra-smooth rotation
const MAX_RPM = 6000;
const MAX_DEGREES_PER_FRAME = 30;
const SMOOTHING_FACTOR = 0.05;
const SENSORS_INTERVAL = 4;       // Run `sensors -j` every Nth poll cycle (~12s)

// Pre-built hwmon shell script (allocated once, never recreated)
const HWMON_SCRIPT = [
    'for dir in /sys/class/hwmon/hwmon*; do',
    '  [ -d "$dir" ] || continue',
    '  chip=$(cat "$dir/name" 2>/dev/null || basename "$dir")',
    '  for f in "$dir"/fan*_input; do',
    '    [ -f "$f" ] || continue',
    '    idx=$(echo "$f" | grep -oP "fan\\K[0-9]+")',
    '    val=$(cat "$f" 2>/dev/null) || continue',
    '    lbl=$(cat "$dir/fan${idx}_label" 2>/dev/null || echo "fan${idx}")',
    '    echo "F|$chip|$idx|$lbl|$val"',
    '  done',
    '  for f in "$dir"/temp*_input; do',
    '    [ -f "$f" ] || continue',
    '    idx=$(echo "$f" | grep -oP "temp\\K[0-9]+")',
    '    val=$(cat "$f" 2>/dev/null) || continue',
    '    lbl=$(cat "$dir/temp${idx}_label" 2>/dev/null || echo "temp${idx}")',
    '    echo "T|$chip|$idx|$lbl|$val"',
    '  done',
    'done',
].join('\n');

// Script to check if the NVIDIA GPU is awake (avoids waking it via nvidia-smi)
const CHECK_NVIDIA_AWAKE_SCRIPT = [
    'AWAKE=1', // Assume awake if no NVIDIA card found or error
    'for d in /sys/bus/pci/devices/*; do',
    '  if [ -f "$d/vendor" ]; then',
    '    v=$(cat "$d/vendor" 2>/dev/null)',
    '    if [ "$v" = "0x10de" ]; then',
    '      AWAKE=0', // Found NVIDIA, default to asleep
    '      if [ -f "$d/power/runtime_status" ]; then',
    '        s=$(cat "$d/power/runtime_status" 2>/dev/null)',
    '        if [ "$s" != "suspended" ]; then',
    '          AWAKE=1',
    '          break',
    '        fi',
    '      else',
    '        AWAKE=1',
    '        break',
    '      fi',
    '    fi',
    '  fi',
    'done',
    'echo $AWAKE',
].join('\n');

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

        // Animation state keyed by fan identifier
        this._fanStates = {};
        // UI element maps for O(1) lookups (was Array.find → O(n))
        this._uiFanMap = new Map();
        this._uiTempMap = new Map();
        // Ordered keys for panel-visible temps
        this._panelTempKeys = [];
        this._panelTempsLabel = null;
        // Hardware topology fingerprint to detect changes
        this._currentFingerprint = '';
        this._uiInitialized = false;

        // Caches to avoid binary probes that already failed
        this._sensorsAvailable = true;
        this._nvidiaAvailable = true;
        // Counter for throttled sensors -j calls
        this._pollCount = 0;

        // Rotation loop (can be paused when all fans are stopped)
        this._rotationLoopId = null;
        this._rotationRunning = false;

        this._updateLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
            this._updateStats();
            return GLib.SOURCE_CONTINUE;
        });

        this._updateStats();
    }

    // ── Subprocess helper ───────────────────────────────────────────────
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

    // ── Main update loop ────────────────────────────────────────────────
    async _updateStats() {
        const fans = [];
        const temps = [];
        const seenKeys = new Set();

        const addFan = f => {
            const k = f.key;
            if (!seenKeys.has(k)) {
                seenKeys.add(k);
                fans.push(f);
            }
        };
        const addTemp = t => {
            const k = t.key;
            if (!seenKeys.has(k)) {
                seenKeys.add(k);
                temps.push(t);
            }
        };

        // 1. hwmon sysfs (always, single subprocess)
        try {
            const hwmon = await this._readHwmonDirect();
            for (let i = 0; i < hwmon.fans.length; i++) addFan(hwmon.fans[i]);
            for (let i = 0; i < hwmon.temps.length; i++) addTemp(hwmon.temps[i]);
        } catch (_e) { /* hwmon unavailable */ }

        // 2. lm-sensors JSON (only used as fallback when hwmon found nothing,
        //    throttled to every Nth cycle, skipped if binary is missing)
        this._pollCount++;
        const hwmonHasData = fans.length > 0 || temps.length > 0;
        if (!hwmonHasData && this._sensorsAvailable && (this._pollCount % SENSORS_INTERVAL) === 0) {
            try {
                const sensorsJson = await this._execAsync(['sensors', '-j']);
                if (sensorsJson) {
                    const parsed = this._parseSensorsJson(sensorsJson);
                    for (let i = 0; i < parsed.fans.length; i++) addFan(parsed.fans[i]);
                    for (let i = 0; i < parsed.temps.length; i++) addTemp(parsed.temps[i]);
                }
            } catch (e) {
                if (/No such file|not found/i.test(e.message))
                    this._sensorsAvailable = false;
            }
        }

        // 3. NVIDIA GPU (skip if binary missing or if GPU is asleep/D3cold)
        if (this._nvidiaAvailable) {
            try {
                const awakeOut = await this._execAsync(['sh', '-c', CHECK_NVIDIA_AWAKE_SCRIPT]);
                if (awakeOut.trim() === '1') {
                    const nvidiaOut = await this._execAsync([
                        'nvidia-smi',
                        '--query-gpu=name,temperature.gpu,fan.speed',
                        '--format=csv,noheader',
                    ]);
                    if (nvidiaOut) this._parseNvidiaOutput(nvidiaOut, addFan, addTemp);
                }
            } catch (e) {
                if (/No such file|not found/i.test(e.message))
                    this._nvidiaAvailable = false;
            }
        }

        // Decide rebuild vs value update
        const fingerprint = this._buildFingerprint(fans, temps);
        if (fingerprint !== this._currentFingerprint) {
            this._currentFingerprint = fingerprint;
            this._rebuildUi(fans, temps);
        } else {
            this._updateUiValues(fans, temps);
        }

        // Start or stop the rotation loop based on whether any fan is active
        this._manageRotationLoop();
    }

    _buildFingerprint(fans, temps) {
        let fp = '';
        for (let i = 0; i < fans.length; i++) {
            if (i > 0) fp += ',';
            fp += fans[i].key;
        }
        fp += '|';
        for (let i = 0; i < temps.length; i++) {
            if (i > 0) fp += ',';
            fp += temps[i].key;
        }
        return fp;
    }

    _parseNvidiaOutput(output, addFan, addTemp) {
        const lines = output.trim().split('\n');
        for (let i = 0; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length < 3) continue;

            const gpuName = parts[0].trim().replace('NVIDIA GeForce ', '');
            const tempVal = parseInt(parts[1], 10);
            const fanStr = parts[2].replace('%', '').trim();

            if (fanStr !== '[Not Supported]') {
                const fanVal = parseInt(fanStr, 10);
                if (!isNaN(fanVal)) {
                    addFan({
                        key: `nvidia_fan_${i}`,
                        label: `${gpuName} Fan`,
                        value: fanVal,
                        isPercentage: true,
                    });
                }
            }

            if (!isNaN(tempVal)) {
                addTemp({
                    key: `nvidia_temp_${i}`,
                    label: gpuName,
                    value: tempVal,
                    category: 'gpu',
                });
            }
        }
    }

    // ── hwmon reader (single shell invocation) ──────────────────────────
    async _readHwmonDirect() {
        const fans = [];
        const temps = [];

        let output;
        try {
            output = await this._execAsync(['sh', '-c', HWMON_SCRIPT]);
        } catch (_e) {
            return {fans, temps};
        }
        if (!output) return {fans, temps};

        const lines = output.trim().split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;

            // Format: TYPE|chip|idx|label|value
            const pipeIdx1 = line.indexOf('|');
            if (pipeIdx1 < 0) continue;
            const pipeIdx2 = line.indexOf('|', pipeIdx1 + 1);
            if (pipeIdx2 < 0) continue;
            const pipeIdx3 = line.indexOf('|', pipeIdx2 + 1);
            if (pipeIdx3 < 0) continue;
            const pipeIdx4 = line.indexOf('|', pipeIdx3 + 1);
            if (pipeIdx4 < 0) continue;

            const type = line.substring(0, pipeIdx1);
            const chip = line.substring(pipeIdx1 + 1, pipeIdx2);
            const idx = line.substring(pipeIdx2 + 1, pipeIdx3);
            const label = line.substring(pipeIdx3 + 1, pipeIdx4);
            const rawValue = parseInt(line.substring(pipeIdx4 + 1), 10);
            if (isNaN(rawValue)) continue;

            if (type === 'F') {
                fans.push({
                    key: `hwmon_${chip}_fan${idx}`,
                    label: `${label} (${chip})`,
                    value: rawValue,
                    isPercentage: false,
                });
            } else if (type === 'T') {
                const tempValue = Math.round(rawValue / 1000);
                temps.push({
                    key: `hwmon_${chip}_temp${idx}`,
                    label: `${label} (${chip})`,
                    value: tempValue,
                    category: this._classifyTemp(chip, label),
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
                            const lbl = feature.startsWith('temp')
                                ? `${feature} (${friendlyChip})`
                                : feature;
                            temps.push({
                                key: `${chip}_${feature}`,
                                label: lbl,
                                value: Math.round(value),
                                category: this._classifyTemp(friendlyChip, lbl),
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

    // Classifies a temperature reading into a category based on the
    // hwmon chip name and sensor label. This lets us intelligently
    // pick one representative temp from each hardware category for
    // the compact panel display.
    //
    // Known chip→category mappings:
    //   CPU:   k10temp (AMD), coretemp (Intel)
    //   GPU:   amdgpu, nouveau, radeon, nvidia
    //   Board: acpitz (ACPI thermal zone)
    //   Disk:  nvme, drivetemp
    _classifyTemp(chip, label) {
        const c = chip.toLowerCase();
        const l = label.toLowerCase();

        // CPU
        if (c === 'k10temp' || c === 'coretemp' || c === 'zenpower')
            return 'cpu';
        if (l.includes('tctl') || l.includes('tdie') || l === 'package id 0')
            return 'cpu';

        // GPU (integrated or discrete)
        if (c === 'amdgpu' || c === 'nouveau' || c === 'radeon')
            return 'gpu';
        if (l === 'edge' || l === 'junction' || l === 'mem')
            return 'gpu';

        // Motherboard / ACPI thermal zone
        if (c === 'acpitz' || c.includes('thinkpad') || c.includes('dell') ||
            c.includes('asus') || c === 'it8665' || c === 'nct6775' ||
            c === 'nct6776' || c === 'nct6779' || c === 'nct6795' ||
            c === 'nct6797' || c === 'nct6798')
            return 'board';

        // Disk (NVMe / SATA)
        if (c === 'nvme' || c === 'drivetemp')
            return 'disk';

        // WiFi / other
        if (c.includes('phy') || c.includes('iwl'))
            return 'other';

        return 'other';
    }

    // Calculates a true System Temperature using Category-Weighted RMS
    _calculateSystemTemp(tempsData) {
        if (tempsData.length === 0) return '--';

        let sumWeightedSquares = 0;
        let sumWeights = 0;

        for (let i = 0; i < tempsData.length; i++) {
            const temp = tempsData[i];
            let w = 0.2; // default low weight
            if (temp.category === 'cpu' || temp.category === 'gpu') w = 1.0;
            else if (temp.category === 'board' || temp.category === 'disk') w = 0.5;

            sumWeightedSquares += w * (temp.value * temp.value);
            sumWeights += w;
        }

        if (sumWeights === 0) return '--';
        return Math.round(Math.sqrt(sumWeightedSquares / sumWeights));
    }

    // ── Rotation loop management ────────────────────────────────────────
    // Only runs the 30fps timer when at least one fan has a visible icon
    // and is actually spinning. Completely paused otherwise → zero CPU
    // when fans are stopped or no fans have panel icons.

    _manageRotationLoop() {
        let anySpinning = false;
        for (const key in this._fanStates) {
            const s = this._fanStates[key];
            if (s.iconActor && (s.targetRpm > 0 || s.currentRpm > 1)) {
                anySpinning = true;
                break;
            }
        }

        if (anySpinning && !this._rotationRunning) {
            this._rotationLoopId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, ROTATION_INTERVAL_MS, () => {
                    this._rotateIcons();
                    return GLib.SOURCE_CONTINUE;
                });
            this._rotationRunning = true;
        } else if (!anySpinning && this._rotationRunning) {
            if (this._rotationLoopId) {
                GLib.Source.remove(this._rotationLoopId);
                this._rotationLoopId = null;
            }
            this._rotationRunning = false;
        }
    }

    // ── UI construction ─────────────────────────────────────────────────

    _rebuildUi(fansData, tempsData) {
        this._box.destroy_all_children();
        this.menu.removeAll();
        this._uiFanMap.clear();
        this._uiTempMap.clear();
        this._panelTempKeys = [];
        this._panelTempsLabel = null;

        // Purge stale animation states
        const activeFanKeys = new Set();
        for (let i = 0; i < fansData.length; i++)
            activeFanKeys.add(fansData[i].key);
        for (const key of Object.keys(this._fanStates)) {
            if (!activeFanKeys.has(key))
                delete this._fanStates[key];
        }

        if (fansData.length === 0 && tempsData.length === 0) {
            this._showFallbackNotice();
            return;
        }

        // ── Fans ────────────────────────────────────────────────────────
        for (let i = 0; i < fansData.length; i++) {
            const fan = fansData[i];
            const unit = fan.isPercentage ? '%' : ' RPM';

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

            const menuItem = new PopupMenu.PopupMenuItem(
                `${fan.label}: ${fan.value}${unit}`);
            this.menu.addMenuItem(menuItem);

            const fanUi = {
                label: fan.label,
                menuItem,
                hasPanelPresence: false,
                unit,
                panelLabel: null,
                lastValue: fan.value,
            };

            // Show first two fans in the top bar with rotating icons
            if (i < 2) {
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

            this._uiFanMap.set(fan.key, fanUi);
        }

        if (fansData.length === 0 && tempsData.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'ℹ️ No fan RPM exposed by this hardware'));
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // ── Temps ───────────────────────────────────────────────────────
        if (fansData.length > 0 && tempsData.length > 0)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (let i = 0; i < tempsData.length; i++) {
            const temp = tempsData[i];
            const catLabel = temp.category && temp.category !== 'other' 
                ? ` [${temp.category.toUpperCase()}]` 
                : '';
                
            const menuItem = new PopupMenu.PopupMenuItem(
                `${temp.label}: ${temp.value}°C${catLabel}`);
            this.menu.addMenuItem(menuItem);

            this._uiTempMap.set(temp.key, {
                label: temp.label,
                menuItem,
                lastValue: temp.value,
                catLabel,
            });
        }

        if (tempsData.length > 0) {
            const sysTemp = this._calculateSystemTemp(tempsData);
            this._panelTempsLabel = new St.Label({
                text: `🔥 ${sysTemp}°C`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 4px; font-weight: bold; color: #ff5500;',
            });
            this._box.add_child(this._panelTempsLabel);
        }

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
        // Update fans — skip set_text if value unchanged
        for (let i = 0; i < fansData.length; i++) {
            const fan = fansData[i];
            if (this._fanStates[fan.key])
                this._fanStates[fan.key].targetRpm = fan.value;

            const ui = this._uiFanMap.get(fan.key);
            if (!ui) continue;

            if (ui.lastValue !== fan.value) {
                ui.lastValue = fan.value;
                ui.menuItem.label.text = `${ui.label}: ${fan.value}${ui.unit}`;
                if (ui.hasPanelPresence && ui.panelLabel)
                    ui.panelLabel.set_text(`${fan.value}${ui.unit}`);
            }
        }

        // Update temps — recalculate RMS system temp if any value changed
        let tempsDirty = false;
        for (let i = 0; i < tempsData.length; i++) {
            const temp = tempsData[i];
            const ui = this._uiTempMap.get(temp.key);
            if (!ui) continue;

            if (ui.lastValue !== temp.value) {
                ui.lastValue = temp.value;
                ui.menuItem.label.text = `${ui.label}: ${temp.value}°C${ui.catLabel}`;
                tempsDirty = true;
            }
        }

        if (tempsDirty && this._panelTempsLabel) {
            const sysTemp = this._calculateSystemTemp(tempsData);
            this._panelTempsLabel.set_text(`🔥 ${sysTemp}°C`);
        }
    }

    // ── Animation (30fps, paused when idle) ─────────────────────────────

    _rotateIcons() {
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

    // ── Fallback ────────────────────────────────────────────────────────

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
        this._rotationRunning = false;
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
