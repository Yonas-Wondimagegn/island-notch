import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {icon, label, guard, dbg} from './widgets.js';

const MARGIN = 14;

function clickable(widget, name, fn) {
    widget.reactive = true;
    widget.track_hover = true;
    widget.connect('button-press-event', guard(name, () => {
        dbg(`click: ${name}`);
        fn();
        return Clutter.EVENT_STOP;
    }));
}

// strip layout
export class Strips {
    constructor({barH, onOverview, onQuickSettings, onDate, iface, notif}) {
        this._barH = barH;
        this._iface = iface;
        this._notif = notif;
        this._tracker = Shell.WindowTracker.get_default();
        this._ids = [];

        // left strip
        this.left = new St.BoxLayout({style_class: 'island-strip island-strip-left'});
        this.left.set_height(barH);
        const logo = new St.BoxLayout({style_class: 'island-strip-btn', y_align: Clutter.ActorAlign.CENTER});
        logo.add_child(icon('start-here-symbolic', 16, 'island-strip-icon'));
        clickable(logo, 'logo', onOverview);
        this._app = label('Desktop', 'island-strip-app');
        this.left.add_child(logo);
        this.left.add_child(this._app);

        // right strip
        this.right = new St.BoxLayout({style_class: 'island-strip island-strip-right'});
        this.right.set_height(barH);
        this._dnd = icon('notifications-disabled-symbolic', 14, 'island-strip-icon');
        this._vol = icon('audio-volume-high-symbolic', 15, 'island-strip-icon');
        this._batIcon = icon('battery-level-100-symbolic', 16, 'island-strip-icon');
        this._batText = label('', 'island-strip-text');
        const qs = icon('preferences-system-symbolic', 15, 'island-strip-icon');

        const group = new St.BoxLayout({style_class: 'island-strip island-strip-group', y_align: Clutter.ActorAlign.CENTER});
        for (const w of [this._dnd, this._vol, this._batIcon, this._batText, qs])
            group.add_child(w);
        clickable(group, 'status icons', onQuickSettings);

        this._date = label('', 'island-strip-text island-strip-date');
        clickable(this._date, 'date', onDate);

        this.right.add_child(group);
        this.right.add_child(this._date);
        this._dnd.hide();
        this._batIcon.hide();

        for (const a of [this.left, this.right])
            Main.layoutManager.addTopChrome(a, {affectsStruts: false, trackFullscreen: true});

        this._ids.push([this.right, this.right.connect('notify::width', () => this._place())]);
        this._ids.push([this._tracker, this._tracker.connect('notify::focus-app', () => this._updateApp())]);

        this._place();
        this._updateApp();
        this.tick();
        this.setDnd(!this._notif.get_boolean('show-banners'));
        this._readVolume();
    }

    _place() {
        const mon = Main.layoutManager.primaryMonitor;
        this.left.set_position(mon.x + MARGIN, mon.y);
        this.right.set_position(mon.x + mon.width - this.right.width - MARGIN, mon.y);
    }

    reposition() {
        this._place();
    }

    _updateApp() {
        this._app.set_text(this._tracker.focus_app?.get_name() ?? 'Desktop');
    }

    tick() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._iface.get_string('clock-format') === '24h';
        const text = now.format(h24 ? '%a %-d %b   %H:%M' : '%a %-d %b   %-I:%M %p');
        if (text !== this._dateText) {
            this._dateText = text;
            this._date.set_text(text);
        }
    }

    setDnd(active) {
        this._dnd.visible = active;
    }

    setBattery(pct, state) {
        if (pct === null || pct === undefined)
            return;
        const charging = state === 1 || state === 5;
        const lvl = Math.max(0, Math.min(100, Math.round(pct / 10) * 10));
        let name = `battery-level-${lvl}-symbolic`;
        if (state === 4)
            name = 'battery-level-100-charged-symbolic';
        else if (charging)
            name = `battery-level-${lvl}-charging-symbolic`;
        this._batIcon.set_icon_name(name);
        this._batIcon.show();
        this._batText.set_text(`${pct}%`);
    }

    setVolume(level, muted = false) {
        let name = 'audio-volume-high-symbolic';
        if (muted || level <= 0)
            name = 'audio-volume-muted-symbolic';
        else if (level < 0.34)
            name = 'audio-volume-low-symbolic';
        else if (level < 0.67)
            name = 'audio-volume-medium-symbolic';
        this._vol.set_icon_name(name);
    }

    _readVolume() {
        try {
            const proc = Gio.Subprocess.new(
                ['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    const m = /Volume:\s*([\d.]+)(.*)/.exec(out ?? '');
                    if (m)
                        this.setVolume(parseFloat(m[1]), m[2].includes('MUTED'));
                } catch (_e) { // wpctl unavailable
                }
            });
        } catch (_e) { // wpctl unavailable
        }
    }

    destroy() {
        for (const [obj, id] of this._ids) {
            try {
                obj.disconnect(id);
            } catch (_e) { // ignore
            }
        }
        this._ids = [];
        for (const a of [this.left, this.right]) {
            Main.layoutManager.removeChrome(a);
            a.destroy();
        }
    }
}
