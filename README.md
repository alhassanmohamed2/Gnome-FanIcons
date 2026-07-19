# GNOME Fan Speed Indicator

![Fan Speed Indicator](example.png)

A GNOME Shell extension that adds beautifully rotating CPU and GPU fan icons to your top bar. It reads real-time data from your system hardware and rotates the fan icons at speeds dynamically mapped to your actual RPM!

## Features
* Dual Fan display for both CPU and GPU.
* Fluid rotation physics mapped proportionally to your live fan speed.
* Zero CSS animations—powered by efficient GJS physics.
* Fans stop completely when RPM drops to 0.
* Built for GNOME 45+ (using modern ESM module imports).

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
