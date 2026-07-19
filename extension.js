import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SENSORS_CMD = ['sensors'];
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

        box.add_child(this._cpuIcon);
        box.add_child(this._cpuLabel);
        box.add_child(this._gpuIcon);
        box.add_child(this._gpuLabel);
        this.add_child(box);

        // State tracking
        this._currentCpuRpm = 0;
        this._targetCpuRpm = 0;
        this._cpuAngle = 0;

        this._currentGpuRpm = 0;
        this._targetGpuRpm = 0;
        this._gpuAngle = 0;

        // Background loops
        this._updateLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
            this._updateFanSpeed();
            return GLib.SOURCE_CONTINUE;
        });

        this._rotationLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ROTATION_INTERVAL_MS, () => {
            this._rotateIcons();
            return GLib.SOURCE_CONTINUE;
        });

        this._updateFanSpeed();
    }

    _updateFanSpeed() {
        try {
            const [ok, stdout, stderr, exit_status] = GLib.spawn_command_line_sync('sensors');
            if (ok && stdout) {
                const textDecoder = new TextDecoder('utf-8');
                const output = textDecoder.decode(stdout);
                this._parseSensorsOutput(output);
            }
        } catch (e) {
            console.error(`Fan Indicator: Error spawning sensors: ${e.message}`);
        }
    }

    _parseSensorsOutput(output) {
        if (!output) {
            return;
        }

        const cpuRegex = /cpu_fan:\s+(\d+)\s+RPM/i;
        const gpuRegex = /gpu_fan:\s+(\d+)\s+RPM/i;

        const cpuMatch = output.match(cpuRegex);
        if (cpuMatch && cpuMatch[1]) {
            this._targetCpuRpm = parseInt(cpuMatch[1], 10);
        } else {
            this._targetCpuRpm = 0; // Fallback to 0 if disconnected or failed
        }

        const gpuMatch = output.match(gpuRegex);
        if (gpuMatch && gpuMatch[1]) {
            this._targetGpuRpm = parseInt(gpuMatch[1], 10);
        } else {
            this._targetGpuRpm = 0; // Fallback to 0 if disconnected or failed
        }

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
