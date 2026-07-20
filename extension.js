import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UPDATE_INTERVAL_MS = 2500;
const ROTATION_INTERVAL_MS = 16; // ~60 fps
const MAX_RPM = 6000;
const MAX_DEGREES_PER_FRAME = 30; // Max rotation speed
const SMOOTHING_FACTOR = 0.05; // For smooth acceleration/deceleration

const FanIndicator = GObject.registerClass(
class FanIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'Fan Indicator');

        // Main layout container
        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            vertical: false,
        });

        // Use the new valid fan SVG provided by the user
        const iconPath = extensionPath + '/fan-symbolic.svg';
        const gicon = Gio.icon_new_for_string(iconPath);

        // --- CPU Fan UI ---
        this._cpuIcon = new St.Icon({
            gicon: gicon,
            style_class: 'system-status-icon',
        });
        this._cpuIcon.set_pivot_point(0.5, 0.5);

        this._cpuLabel = new St.Label({
            text: '0 RPM',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 4px; margin-right: 12px; font-weight: bold;',
        });

        // --- GPU Fan UI ---
        this._gpuIcon = new St.Icon({
            gicon: gicon,
            style_class: 'system-status-icon',
        });
        this._gpuIcon.set_pivot_point(0.5, 0.5);

        this._gpuLabel = new St.Label({
            text: '0 RPM',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 4px; font-weight: bold;',
        });

        // --- Temperatures UI ---
        this._tempsLabel = new St.Label({
            text: '--°C | --°C | --°C | --°C',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 12px; font-weight: bold; color: #a8a8a8;',
        });

        box.add_child(this._cpuIcon);
        box.add_child(this._cpuLabel);
        box.add_child(this._gpuIcon);
        box.add_child(this._gpuLabel);
        box.add_child(this._tempsLabel);
        this.add_child(box);

        // State tracking
        this._currentCpuRpm = 0;
        this._targetCpuRpm = 0;
        this._cpuAngle = 0;

        this._currentGpuRpm = 0;
        this._targetGpuRpm = 0;
        this._gpuAngle = 0;
        
        // Temps
        this._tctlTemp = '--';
        this._edgeTemp = '--';
        this._acpitzTemp = '--';
        this._rtxTemp = '--';

        // Background loops
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

    async _execAsync(argv) {
        return new Promise((resolve, reject) => {
            try {
                const proc = new Gio.Subprocess({
                    argv: argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);

                proc.communicate_utf8_async(null, null, (obj, res) => {
                    try {
                        const [ok, stdout, stderr] = obj.communicate_utf8_finish(res);
                        if (ok) resolve(stdout);
                        else reject(new Error(stderr));
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
        try {
            const sensorsOut = await this._execAsync(['sensors']);
            if (sensorsOut) this._parseSensorsOutput(sensorsOut);
        } catch (e) {
            console.error(`Fan Indicator: sensors error: ${e.message}`);
        }

        try {
            const nvidiaOut = await this._execAsync(['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader']);
            if (nvidiaOut) {
                const temp = nvidiaOut.trim();
                if (temp) this._rtxTemp = temp;
            }
        } catch (e) {
            console.error(`Fan Indicator: nvidia-smi error: ${e.message}`);
        }

        // Update Temps Text (Tctl | edge | acpitz | RTX)
        this._tempsLabel.set_text(`${this._tctlTemp}°C | ${this._edgeTemp}°C | ${this._acpitzTemp}°C | ${this._rtxTemp}°C`);
    }

    _parseSensorsOutput(output) {
        // Parse Fans
        const cpuMatch = output.match(/cpu_fan:\s+(\d+)\s+RPM/i);
        this._targetCpuRpm = (cpuMatch && cpuMatch[1]) ? parseInt(cpuMatch[1], 10) : 0;

        const gpuMatch = output.match(/gpu_fan:\s+(\d+)\s+RPM/i);
        this._targetGpuRpm = (gpuMatch && gpuMatch[1]) ? parseInt(gpuMatch[1], 10) : 0;

        // Parse Temps
        const tctlMatch = output.match(/Tctl:\s+\+([0-9.]+)/);
        if (tctlMatch) this._tctlTemp = Math.round(parseFloat(tctlMatch[1])).toString();

        const edgeMatch = output.match(/edge:\s+\+([0-9.]+)/);
        if (edgeMatch) this._edgeTemp = Math.round(parseFloat(edgeMatch[1])).toString();

        const acpitzMatch = output.match(/acpitz-acpi-0[\s\S]*?temp1:\s+\+([0-9.]+)/);
        if (acpitzMatch) this._acpitzTemp = Math.round(parseFloat(acpitzMatch[1])).toString();

        // Update UI Text
        this._cpuLabel.set_text(`${this._targetCpuRpm} RPM`);
        this._gpuLabel.set_text(`${this._targetGpuRpm} RPM`);
    }

    _rotateIcons() {
        // Smoothly approach real RPM for both fans
        this._currentCpuRpm += (this._targetCpuRpm - this._currentCpuRpm) * SMOOTHING_FACTOR;
        this._currentGpuRpm += (this._targetGpuRpm - this._currentGpuRpm) * SMOOTHING_FACTOR;

        // CPU Rotation
        if (this._currentCpuRpm >= 50) {
            const cpuRatio = Math.min(this._currentCpuRpm / MAX_RPM, 1.0);
            this._cpuAngle = (this._cpuAngle + cpuRatio * MAX_DEGREES_PER_FRAME) % 360;
            this._cpuIcon.rotation_angle_z = this._cpuAngle;
        }

        // GPU Rotation
        if (this._currentGpuRpm >= 50) {
            const gpuRatio = Math.min(this._currentGpuRpm / MAX_RPM, 1.0);
            this._gpuAngle = (this._gpuAngle + gpuRatio * MAX_DEGREES_PER_FRAME) % 360;
            this._gpuIcon.rotation_angle_z = this._gpuAngle;
        }
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
        // The third parameter is the position index, the fourth is the box ('left', 'center', or 'right')
        Main.panel.addToStatusArea('fan-indicator', this._indicator, 1, 'left');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
