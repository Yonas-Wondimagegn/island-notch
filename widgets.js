import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

// guard
export function guard(name, fn) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (e) {
            console.error(`island-notch: ${name} failed: ${e.message}\n${e.stack}`);
            return undefined;
        }
    };
}

export function dbg(msg) {
    console.log(`island-notch: ${msg}`);
}

export function label(text, cls = '') {
    return new St.Label({text, style_class: cls, y_align: Clutter.ActorAlign.CENTER});
}

export function ellipsized(text, cls = '') {
    const l = label(text, cls);
    l.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    return l;
}

export function icon(name, size = 16, cls = '') {
    return new St.Icon({icon_name: name, icon_size: size, style_class: cls});
}

export function iconButton(name, cb, cls = 'island-btn', size = 16) {
    const b = new St.Button({
        style_class: cls, child: icon(name, size), reactive: true, can_focus: true, track_hover: true,
    });
    b.connect('clicked', guard('button', cb));
    return b;
}

export function chip(text, cb) {
    const b = new St.Button({
        style_class: 'island-chip', label: text, reactive: true, can_focus: true, track_hover: true,
    });
    b.connect('clicked', guard('chip', cb));
    return b;
}

export function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function plain(text) {
    return (text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// cover art
export function setCover(bin, path, fallbackSize = 16) {
    if (bin._coverPath === path)
        return;
    bin._coverPath = path;
    if (path) {
        const p = path.replace(/(["\\])/g, '\\$1');
        bin.set_child(null);
        bin.set_style(`background-image: url("${p}"); background-size: cover; background-position: center;`);
    } else {
        bin.set_style(null);
        bin.set_child(icon('audio-x-generic-symbolic', fallbackSize, 'island-music-icon'));
    }
}
