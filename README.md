# Island 🏝️

A macOS inspired dynamic island for GNOME Shell

It transform the traditional GNOME top bar into a sleek, interactive pill that expands to display useful information and quick controls by bringing a little macOS magic to the Linux desktop

## ✨ Features

- 🎵 **Media Controls** — View currently playing music and interact with media playback
- 🔔 **Notifications** — Display notification related info and quick controls
- 🔋 **Battery & Charging** — Show power and charging status
- 🔊 **Volume & Brightness** — Interactive on screen displays for system adjustments
- ⏱️ **Timers & Sleep Timer** — Manage countdowns and sleep timers
- 📝 **Reminders** — Create and manage reminders
- 📅 **Calendar** — Access a calendar view
- 📋 **Clipboard History** — Access previously copied content
- 🎤 **Lyrics Support** — Fetch and display some song lyrics when available

## 🖥️ Requirements

- it needs linux running GNOME Shell
- GNOME Shell have to be either 49 or 50

## 📦 Installation

### Manual installation

1. Clone this repository:

   ```bash
   git clone https://github.com/Yonas-Wondimagegn/island-notch.git
   ```

2. Create the GNOME extensions directory if it doesn't exist:

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions
   ```

3. Copy the extension into the extensions directory:

   ```bash
   cp -r island-notch \
   ~/.local/share/gnome-shell/extensions/island-notch@alex
   ```

4. Enable the extension:

   ```bash
   gnome-extensions enable island-notch@alex
   ```


the extension doesn't appear immediately you have to log out and back in or restart GNOME Shell using the appropriate method for your session 

and actually you can also enable or disable the extension through the GNOME extensions app

## 🛠️ Built With

- JS (GJS)
- GNOME Shell Extension APIs
- GTK/Clutter based GNOME Shell UI components
- and ofc CSS

## 📁 Project Structure

```text
island-notch/
├── extension.js       # extension entry point
├── metadata.json      # GNOME extension metadata
├── island.js          # main island interface and logic
├── services.js        # system integrations and services
├── widgets.js         # reusable UI helpers
├── pages.js           # expanded interface pages
├── strips.js          # top bar components
└── stylesheet.css     # styling
```

## 🚧 Project Status

Right now Island is a work in progress im trying to expland its features, UI components  and system integrations may change as development continues so feel free to reach out and give your idea:)

## 🤝 Contributing

Contributions, suggestions,bug reports are welcome!!!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request



## License

Island is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later). See [LICENSE](LICENSE) for details.

Made with ❤️ for the GNOME desktop community ;)
