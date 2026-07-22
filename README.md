# GNOME Fan Speed Indicator

![Fan Speed Indicator](example.png)

A GNOME Shell extension that adds beautifully rotating CPU and GPU fan icons to your top bar. It reads real-time data from your system hardware and rotates the fan icons at speeds dynamically mapped to your actual RPM!

## Features
* **Universal Hardware Support:** Auto-detects fans and thermal sensors via direct `hwmon` sysfs reads, `lm-sensors`, and `nvidia-smi` without requiring complex configuration.
* **Smart Temperature Tracking:** Intelligently scans and categorizes your hardware sensors to automatically display your most critical temperatures: **CPU, GPU, Motherboard, and Disk**.
* **Interactive Popup Menu:** Click the top bar to see a detailed dropdown menu mapping every fan speed and temperature to its specific hardware component. Uses indexed tracking `(1)`, `(2)`, etc. to easily match top-bar readings to their exact hardware labels.
* **Clean Top Bar Readouts:** Displays rotating fan icons, RPM speeds, and a compact fiery temperature readout (`🔥 64°C | 53°C | ...`).
* **Fluid Rotation Physics:** Fan animation speeds are mapped proportionally to your live hardware RPM.
* **Built for GNOME 46+:** Fully modernized using ESM module imports.

## Performance & Optimizations
This extension is heavily optimized to consume almost zero CPU and RAM:
* **Zero Idle CPU:** The rotation animation loop automatically pauses when all fans drop to 0 RPM.
* **Zero GPU Wakeups:** Smartly checks the PCI power state of NVIDIA GPUs and safely skips querying them if they are asleep (D3cold), saving massive amounts of laptop battery life.
* **Efficient Polling:** Uses `lm-sensors` only as a fallback, throttles heavy subprocess spawns, and caches binary availability to prevent wasted CPU cycles.
* **Consolidated Sysfs Reads:** Uses a single shell command to read all `/sys/class/hwmon` directories at once instead of spawning dozens of individual subprocesses.
* **60 FPS Physics:** Buttery smooth `GJS` physics animations dynamically synced to 60 FPS for ultra-fluid fan rotation.
* **O(1) UI Updates:** Caches hardware states using fast Map lookups and strictly skips DOM redraws unless a temperature or RPM value actually changes.

## Requirements
This extension requires the `sensors` command to be installed and accessible on your system.
For Fedora/Ubuntu/Debian systems, install `lm_sensors`:
```bash
sudo dnf install lm_sensors  # Fedora
sudo apt install lm-sensors  # Ubuntu/Debian
```

## Manual Installation
1. Clone this repository into your GNOME Shell extensions directory:
```bash
git clone https://github.com/alhassanmohamed2/Gnome-FanIcons.git ~/.local/share/gnome-shell/extensions/fan-icon@alhassan
```
2. Log out and log back in (required on Wayland).
3. Enable the extension via the **Extensions** app or GNOME Tweaks.
