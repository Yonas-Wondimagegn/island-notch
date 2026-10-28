import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {label, ellipsized, icon, iconButton, chip, fmtClock, guard, setCover} from './widgets.js';

const CENTER = Clutter.ActorAlign.CENTER;
const PRESETS = [5, 10, 25, 50];

function backHeader(card, title, extras = []) {
    const row = new St.BoxLayout({style_class: 'island-hdr', x_expand: true});
    row.add_child(iconButton('go-previous-symbolic', () => card.show('home'), 'island-btn island-btn-xs', 14));
    const t = label(title, 'island-title');
    t.set_x_expand(true);
    row.add_child(t);
    for (const e of extras)
        row.add_child(e);
    return row;
}

// home page

class HomePage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this._artUrl = null;
        this._trackKey = null;
        this._pos = 0;
        this._lyrics = null;
        this._lyrIdx = -2;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'island-home2', x_expand: true, y_expand: true});

        // cover + title
        const top = new St.BoxLayout({style_class: 'island-mrow2', x_align: CENTER});
        this._art = new St.Bin({style_class: 'island-art2', child: icon('audio-x-generic-symbolic', 22)});
        const col = new St.BoxLayout({vertical: true, y_align: CENTER});
        this._title = ellipsized('Nothing playing', 'island-title island-ell-m2');
        this._artist = ellipsized('', 'island-sub island-ell-m2');
        col.add_child(this._title);
        col.add_child(this._artist);
        top.add_child(this._art);
        top.add_child(col);

        // lyrics block
        this._lyr = new St.BoxLayout({style_class: 'island-lyr', x_expand: true});
        this._lyr.hide();
        this._syn = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true, y_align: CENTER});
        this._lyrPrev = ellipsized('', 'island-lyr-dim');
        this._lyrCur = ellipsized('', 'island-lyr-cur');
        this._lyrNext = ellipsized('', 'island-lyr-dim');
        for (const l of [this._lyrPrev, this._lyrCur, this._lyrNext]) {
            l.set_x_align(CENTER);
            this._syn.add_child(l);
        }
        this._plainScroll = new St.ScrollView({
            style_class: 'island-lyr-scroll', x_expand: true, y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._plainText = label('', 'island-lyr-plain');
        this._plainText.clutter_text.set_line_wrap(true);
        this._plainText.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        const plainBox = new St.BoxLayout({vertical: true, x_expand: true});
        plainBox.add_child(this._plainText);
        this._plainScroll.add_child(plainBox);
        this._lyr.add_child(this._syn);
        this._lyr.add_child(this._plainScroll);

        // progress bar
        const prog = new St.BoxLayout({style_class: 'island-prog', x_expand: true});
        this._cur = label('0:00', 'island-time-s');
        this._rem = label('', 'island-time-s');
        this._fill = new St.Widget({style_class: 'island-fill island-fill-w'});
        this._fill.set_size(0, 4);
        this._track = new St.Widget({style_class: 'island-track', x_expand: true, y_align: CENTER});
        this._track.set_height(4);
        this._track.add_child(this._fill);
        const hit = new St.BoxLayout({style_class: 'island-hit', x_expand: true, reactive: true});
        hit.add_child(this._track);
        hit.connect('button-press-event', guard('seek', (_a, ev) => {
            const [x] = ev.get_coords();
            const [tx] = this._track.get_transformed_position();
            const w = this._track.get_width();
            if (w > 0)
                ctx.mpris.seek(Math.max(0, Math.min(1, (x - tx) / w)));
            return Clutter.EVENT_STOP;
        }));
        prog.add_child(this._cur);
        prog.add_child(hit);
        prog.add_child(this._rem);

        // transport
        this._ctl = new St.BoxLayout({style_class: 'island-ctl2', x_align: CENTER});
        this._ctl.add_child(iconButton('view-list-symbolic', () => card.show('music'), 'island-btn island-btn-sm', 15));
        this._ctl.add_child(iconButton('media-skip-backward-symbolic', () => ctx.mpris.control('Previous'), 'island-btn island-btn-sm', 15));
        this._play = iconButton('media-playback-start-symbolic', () => ctx.mpris.control('PlayPause'), 'island-btn island-btn-playx', 17);
        this._ctl.add_child(this._play);
        this._ctl.add_child(iconButton('media-skip-forward-symbolic', () => ctx.mpris.control('Next'), 'island-btn island-btn-sm', 15));
        this._star = iconButton('non-starred-symbolic', () => ctx.toggleFavorite(), 'island-btn island-btn-sm', 15);
        this._ctl.add_child(this._star);

        // quick actions
        const icons = new St.BoxLayout({style_class: 'island-icons', x_align: CENTER});
        const go = (name, color, page) => iconButton(name, () => card.show(page), `island-btn island-btn-xs island-ico-${color}`, 14);
        icons.add_child(go('x-office-calendar-symbolic', 'red', 'calendar'));
        icons.add_child(go('alarm-symbolic', 'orange', 'timer'));
        icons.add_child(go('appointment-soon-symbolic', 'yellow', 'reminders'));
        icons.add_child(go('folder-symbolic', 'blue', 'tray'));
        icons.add_child(go('edit-paste-symbolic', 'purple', 'clipboard'));
        icons.add_child(new St.Widget({style_class: 'island-sep', y_align: CENTER}));
        this._dnd = iconButton('notifications-disabled-symbolic', () => {
            ctx.toggleDnd();
            this.refresh();
        }, 'island-btn island-btn-xs', 14);
        icons.add_child(this._dnd);
        icons.add_child(iconButton('view-app-grid-symbolic', () => ctx.overview(), 'island-btn island-btn-xs', 14));
        icons.add_child(iconButton('preferences-system-symbolic', () => ctx.toggleQuickSettings(), 'island-btn island-btn-xs', 14));
        icons.add_child(iconButton('system-lock-screen-symbolic', () => ctx.lock(), 'island-btn island-btn-xs', 14));

        this.actor.add_child(top);
        this.actor.add_child(this._lyr);
        this.actor.add_child(prog);
        this.actor.add_child(this._ctl);
        this.actor.add_child(icons);
    }

    setPosition(us) {
        this._pos = us;
        this._drawProgress();
    }

    _drawProgress() {
        const len = this.ctx.media()?.length ?? 0;
        const frac = len > 0 ? Math.max(0, Math.min(1, this._pos / len)) : 0;
        this._fill.set_width(Math.round(frac * (this._track.get_width() || 280)));
        this._cur.set_text(fmtClock(this._pos / 1e6));
        this._rem.set_text(len > 0 ? `-${fmtClock(Math.max(0, len - this._pos) / 1e6)}` : '');
        this._drawLyrics(this._pos);
    }

    _setLyrics(lyr) {
        this._lyrics = lyr;
        this._lyrIdx = -2;
        const synced = !!lyr?.synced?.length;
        const plain = !synced && !!lyr?.plain;
        this._lyr.visible = synced || plain;
        this._syn.visible = synced;
        this._plainScroll.visible = plain;
        if (plain)
            this._plainText.set_text(lyr.plain.trim());
        if (synced)
            this._drawLyrics(this._pos);
    }

    _drawLyrics(us) {
        const L = this._lyrics?.synced;
        if (!L?.length)
            return;
        const ms = us / 1000 + 200;          // sync offset
        let i = -1;
        for (let k = 0; k < L.length; k++) {
            if (L[k].t <= ms)
                i = k;
            else
                break;
        }
        if (i === this._lyrIdx)
            return;
        this._lyrIdx = i;
        const t = k => (L[k] ? (L[k].text || '♪') : '');
        this._lyrPrev.set_text(t(i - 1));
        this._lyrCur.set_text(i >= 0 ? t(i) : '♪');
        this._lyrNext.set_text(t(i + 1));
    }

    refresh() {
        const ctx = this.ctx;
        const m = ctx.media();
        this._title.set_text(m?.title || (m ? 'Unknown track' : 'Nothing playing'));
        this._artist.set_text(m?.artist ?? '');
        this._artist.visible = !!m?.artist;
        this._ctl.opacity = m ? 255 : 110;
        const lyr = ctx.lyrics?.() ?? null;
        if (lyr !== this._lyrics)
            this._setLyrics(lyr);

        const art = ctx.artPath();
        if (art !== this._artUrl) {
            this._artUrl = art;
            setCover(this._art, art, 22);
        }
        this._play.set_child(icon(m?.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic', 17));
        this._star.set_child(icon(ctx.isFavorite(m) ? 'starred-symbolic' : 'non-starred-symbolic', 15));

        const key = m ? `${m.bus}|${m.title}|${m.artist}` : null;
        if (key !== this._trackKey) {
            this._trackKey = key;
            this._pos = 0;
        }
        this._drawProgress();

        if (ctx.isDnd())
            this._dnd.add_style_class_name('active');
        else
            this._dnd.remove_style_class_name('active');
    }
}

// calendar page

class CalendarPage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this.actor = new St.BoxLayout({style_class: 'island-detail', x_expand: true, y_expand: true});
        const row = new St.BoxLayout({style_class: 'island-detail-row', x_align: CENTER, x_expand: true});
        const left = new St.BoxLayout({vertical: true, style_class: 'island-calleft2'});
        left.add_child(iconButton('go-previous-symbolic', () => card.show('home'), 'island-btn island-btn-xs', 14));
        this._leftBody = new St.BoxLayout({vertical: true});
        left.add_child(this._leftBody);
        this._right = new St.BoxLayout({vertical: true, style_class: 'island-calright'});
        row.add_child(left);
        row.add_child(this._right);
        this.actor.add_child(row);
    }

    refresh() {
        const now = GLib.DateTime.new_now_local();
        this._leftBody.destroy_all_children();
        this._leftBody.add_child(label(now.format('%A').toUpperCase(), 'island-cal-red'));
        this._leftBody.add_child(label(String(now.get_day_of_month()), 'island-cal-daynum'));

        const endOfDay = GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(), 23, 59, 59);
        const next = this.ctx.reminders.list().find(r => r.due <= endOfDay.to_unix() * 1000);
        if (next) {
            const when = GLib.DateTime.new_from_unix_local(Math.floor(next.due / 1000)).format('%H:%M');
            const ev = new St.BoxLayout({vertical: true, style_class: 'island-event'});
            ev.add_child(ellipsized(next.text, 'island-title island-ell-s'));
            ev.add_child(label(when, 'island-sub'));
            this._leftBody.add_child(ev);
        }

        this._right.destroy_all_children();
        const first = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0);
        const days = first.add_months(1).add_days(-1).get_day_of_month();
        const offset = first.get_day_of_week() - 1;
        const todayNum = now.get_day_of_month();

        this._right.add_child(label(first.format('%B %Y').toUpperCase(), 'island-cal-red'));
        const dow = new St.BoxLayout();
        ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d, i) =>
            dow.add_child(label(d, `island-day island-dow${i >= 5 ? ' island-wknd' : ''}`)));
        this._right.add_child(dow);

        let day = 1 - offset;
        for (let r = 0; r < 6 && day <= days; r++) {
            const row = new St.BoxLayout();
            for (let c = 0; c < 7; c++, day++) {
                const inMonth = day >= 1 && day <= days;
                let cls = 'island-day';
                if (inMonth && day === todayNum)
                    cls += ' island-today';
                else if (c >= 5)
                    cls += ' island-wknd';
                row.add_child(label(inMonth ? String(day) : '', cls));
            }
            this._right.add_child(row);
        }
    }
}

// timer page

class TimerPage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'island-detail', x_expand: true, y_expand: true});
        this.actor.add_child(backHeader(card, 'Timer'));

        this._time = label('Pick a time', 'island-timer');
        this._time.set_x_align(CENTER);
        this.actor.add_child(this._time);

        const row = new St.BoxLayout({style_class: 'island-trow', x_align: CENTER});
        this._play = iconButton('media-playback-start-symbolic', () => ctx.toggleTimer(), 'island-btn island-btn-timer');
        row.add_child(iconButton('process-stop-symbolic', () => ctx.resetTimer(), 'island-btn'));
        row.add_child(this._play);
        this.actor.add_child(row);

        const chips = new St.BoxLayout({style_class: 'island-chips', x_align: CENTER});
        for (const m of PRESETS)
            chips.add_child(chip(`${m} min`, () => ctx.startTimer(m * 60)));
        this.actor.add_child(chips);
    }

    tick() {
        this.refresh();
    }

    refresh() {
        const t = this.ctx.timer;
        this._time.set_text(t.remaining > 0 ? fmtClock(t.remaining) : 'Pick a time');
        this._play.set_child(icon(t.running
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic', 16));
    }
}

// reminders page

function whenParts(ms) {
    const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const [y, m, day] = d.get_ymd();
    const [ny, nm, nd] = now.get_ymd();
    const [ty, tm, td] = now.add_days(1).get_ymd();
    let label_ = d.format('%a %-d %b');
    if (y === ny && m === nm && day === nd)
        label_ = 'Today';
    else if (y === ty && m === tm && day === td)
        label_ = 'Tomorrow';
    return {day: label_, hour: d.format('%H'), min: d.format('%M'), time: d.format('%H:%M')};
}

class RemindersPage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this._when = this._defaultWhen();
        this.actor = new St.BoxLayout({vertical: true, style_class: 'island-detail', x_expand: true, y_expand: true});
        this.actor.add_child(backHeader(card, 'Reminders'));

        this.entry = new St.Entry({style_class: 'island-entry', hint_text: 'Remind me to…', can_focus: true, x_expand: true});
        this.entry.connect('button-press-event', () => {
            ctx.beginTyping();
            return Clutter.EVENT_PROPAGATE;
        });
        this.entry.clutter_text.connect('activate', guard('entry', () => this._add()));
        this.actor.add_child(this.entry);

        // date picker
        const pick = new St.BoxLayout({style_class: 'island-pick', x_align: CENTER});
        const step = (name, ms) => iconButton(name, () => this._shift(ms), 'island-btn island-btn-xxs', 12);
        this._dayL = label('', 'island-pick-day');
        this._hourL = label('', 'island-pick-num');
        this._minL = label('', 'island-pick-num');
        pick.add_child(step('go-previous-symbolic', -86400000));
        pick.add_child(this._dayL);
        pick.add_child(step('go-next-symbolic', 86400000));
        pick.add_child(new St.Widget({style_class: 'island-sep', y_align: CENTER}));
        pick.add_child(step('go-previous-symbolic', -3600000));
        pick.add_child(this._hourL);
        pick.add_child(step('go-next-symbolic', 3600000));
        pick.add_child(label(':', 'island-pick-num'));
        pick.add_child(step('go-previous-symbolic', -300000));
        pick.add_child(this._minL);
        pick.add_child(step('go-next-symbolic', 300000));
        const add = chip('Add', () => this._add());
        add.add_style_class_name('island-chip-accent');
        pick.add_child(add);
        this.actor.add_child(pick);

        this._list = new St.BoxLayout({vertical: true, style_class: 'island-rlist'});
        this.actor.add_child(this._list);
    }

    _defaultWhen() {
        return Math.ceil((Date.now() + 10 * 60000) / 300000) * 300000;
    }

    _shift(ms) {
        this._when += ms;
        this._draw();
    }

    _draw() {
        const w = whenParts(this._when);
        this._dayL.set_text(w.day);
        this._hourL.set_text(w.hour);
        this._minL.set_text(w.min);
    }

    _add() {
        const text = this.entry.get_text().trim() || 'Reminder';
        const due = Math.max(this._when, Date.now() + 60000);
        this.entry.set_text('');
        this._when = this._defaultWhen();
        this._draw();
        this.ctx.addReminder(text, due);
    }

    refresh() {
        if (this._when < Date.now())
            this._when = this._defaultWhen();
        this._draw();
        this._list.destroy_all_children();
        for (const r of this.ctx.reminders.list().slice(0, 2)) {
            const w = whenParts(r.due);
            const row = new St.BoxLayout({style_class: 'island-rrow', x_expand: true});
            const text = ellipsized(r.text, 'island-sub island-ell-m2');
            text.set_x_expand(true);
            row.add_child(text);
            row.add_child(label(`${w.day} ${w.time}`, 'island-sub'));
            row.add_child(iconButton('window-close-symbolic', () => this.ctx.removeReminder(r.id), 'island-x', 12));
            this._list.add_child(row);
        }
    }
}

// file tray

class TrayPage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'island-detail', x_expand: true, y_expand: true});
        this.actor.add_child(backHeader(card, 'File Tray', [
            iconButton('edit-paste-symbolic', () => this._paste(), 'island-btn island-btn-xs', 14),
            iconButton('edit-copy-symbolic', () => this._copy(ctx.tray.items.map(i => i.uri)), 'island-btn island-btn-xs', 14),
            iconButton('edit-clear-all-symbolic', () => {
                ctx.tray.clear();
                this.refresh();
            }, 'island-btn island-btn-xs', 14),
        ]));
        this._list = new St.BoxLayout({vertical: true, style_class: 'island-flist', x_expand: true});
        this.actor.add_child(this._list);
    }

    _paste() {
        const clip = St.Clipboard.get_default();
        const types = ['x-special/gnome-copied-files', 'text/uri-list'];
        const attempt = i => {
            if (i >= types.length)
                return;
            clip.get_content(St.ClipboardType.CLIPBOARD, types[i], (_c, bytes) => {
                let text = '';
                try {
                    text = bytes ? new TextDecoder().decode(bytes.get_data()) : '';
                } catch (_e) { /* ignore */ }
                const uris = text.split('\n').map(s => s.trim()).filter(s => s.startsWith('file://'));
                if (!uris.length) {
                    attempt(i + 1);
                    return;
                }
                for (const uri of uris)
                    this.ctx.tray.add({uri}, (a, b) => a.uri === b.uri);
                this.refresh();
            });
        };
        attempt(0);
    }

    _copy(uris) {
        if (!uris.length)
            return;
        const data = new TextEncoder().encode(`copy\n${uris.join('\n')}`);
        St.Clipboard.get_default().set_content(
            St.ClipboardType.CLIPBOARD, 'x-special/gnome-copied-files', GLib.Bytes.new(data));
    }

    refresh() {
        this._list.destroy_all_children();
        const items = this.ctx.tray.items.filter(i => Gio.File.new_for_uri(i.uri).query_exists(null));
        if (items.length !== this.ctx.tray.items.length) {
            this.ctx.tray.items = items;
            this.ctx.tray.save();
        }
        if (!items.length) {
            this._list.add_child(label('Copy files in Files (Ctrl+C), then tap paste.', 'island-sub'));
            return;
        }
        for (const it of items.slice(0, 3)) {
            const file = Gio.File.new_for_uri(it.uri);
            let gicon = null;
            let name = file.get_basename();
            try {
                const info = file.query_info('standard::icon,standard::display-name', Gio.FileQueryInfoFlags.NONE, null);
                gicon = info.get_icon();
                name = info.get_display_name();
            } catch (_e) { /* keep basename */ }

            const row = new St.BoxLayout({style_class: 'island-frow', x_expand: true});
            const inner = new St.BoxLayout({style_class: 'island-frow-in', x_expand: true});
            inner.add_child(new St.Icon({gicon: gicon ?? new Gio.ThemedIcon({name: 'text-x-generic'}), icon_size: 20}));
            inner.add_child(ellipsized(name, 'island-title island-ell-m2'));
            const open = new St.Button({child: inner, style_class: 'island-fbtn', x_expand: true, reactive: true, can_focus: true, track_hover: true});
            open.connect('clicked', guard('open file', () => {
                Gio.AppInfo.launch_default_for_uri(it.uri, null);
                this.ctx.collapse();
            }));
            row.add_child(open);
            row.add_child(iconButton('edit-copy-symbolic', () => this._copy([it.uri]), 'island-x', 14));
            row.add_child(iconButton('window-close-symbolic', () => {
                this.ctx.tray.removeWhere(i => i.uri === it.uri);
                this.refresh();
            }, 'island-x', 12));
            this._list.add_child(row);
        }
        if (items.length > 3)
            this._list.add_child(label(`+${items.length - 3} more`, 'island-sub'));
    }
}

/* ------------------------------------------------------------- Clipboard */

class ClipboardPage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'island-detail', x_expand: true, y_expand: true});
        const clear = chip('Clear', () => {
            ctx.clipboard.clearUnpinned();
            this.refresh();
        });
        this.actor.add_child(backHeader(card, 'Clipboard', [clear]));
        this._list = new St.BoxLayout({vertical: true, style_class: 'island-flist', x_expand: true});
        this.actor.add_child(this._list);
    }

    refresh() {
        this._list.destroy_all_children();
        const entries = this.ctx.clipboard?.entries() ?? [];
        if (!entries.length) {
            this._list.add_child(label('Copy something. Pin it to keep it.', 'island-sub'));
            return;
        }
        for (const e of entries.slice(0, 4)) {
            const row = new St.BoxLayout({style_class: 'island-frow', x_expand: true});
            row.add_child(iconButton('view-pin-symbolic', () => {
                if (e.pinned)
                    this.ctx.clipboard.unpin(e.text);
                else
                    this.ctx.clipboard.pin(e.text);
                this.refresh();
            }, `island-btn island-btn-xxs${e.pinned ? ' island-pin-on' : ''}`, 12));
            const b = new St.Button({
                child: ellipsized(e.text.replace(/\s+/g, ' ').slice(0, 140), 'island-sub island-clip'),
                style_class: 'island-fbtn', x_expand: true, reactive: true, can_focus: true, track_hover: true,
            });
            b.connect('clicked', guard('copy clip', () => {
                this.ctx.clipboard.copy(e.text);
                this.ctx.collapse();
            }));
            row.add_child(b);
            row.add_child(iconButton('window-close-symbolic', () => {
                this.ctx.clipboard.remove(e.text);
                this.refresh();
            }, 'island-x', 12));
            this._list.add_child(row);
        }
    }
}

// music menu

const SLEEP_PRESETS = [15, 30, 45, 60];

class MusicMenuPage {
    constructor(ctx, card) {
        this.ctx = ctx;
        this._tab = 'favs';
        this._req = 0;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'island-detail', x_expand: true, y_expand: true});
        this.actor.add_child(backHeader(card, 'Music'));

        const seg = new St.BoxLayout({style_class: 'island-chips', x_align: CENTER});
        this._seg = {};
        for (const [key, text] of [['favs', 'Favorites'], ['queue', 'Up next'], ['sleep', 'Sleep timer']]) {
            this._seg[key] = chip(text, () => {
                this._tab = key;
                this.refresh();
            });
            seg.add_child(this._seg[key]);
        }
        this.actor.add_child(seg);

        this._body = new St.BoxLayout({vertical: true, style_class: 'island-flist', x_expand: true});
        this.actor.add_child(this._body);
    }

    tick() {
        if (this._tab === 'sleep')
            this.refresh();
    }

    refresh() {
        this._req++;
        for (const [k, b] of Object.entries(this._seg)) {
            if (k === this._tab)
                b.add_style_class_name('active');
            else
                b.remove_style_class_name('active');
        }
        this._body.destroy_all_children();
        if (this._tab === 'favs')
            this._favs();
        else if (this._tab === 'queue')
            this._queue();
        else
            this._sleep();
    }

    _favs() {
        const favs = this.ctx.favorites.items;
        if (!favs.length) {
            this._body.add_child(label('Tap ☆ on a playing track to save it here.', 'island-sub'));
            return;
        }
        for (const f of favs.slice(0, 3)) {
            const row = new St.BoxLayout({style_class: 'island-frow', x_expand: true});
            row.add_child(iconButton('media-playback-start-symbolic', () => this.ctx.playFavorite(f), 'island-btn island-btn-xs', 12));
            const col = new St.BoxLayout({vertical: true, x_expand: true, y_align: CENTER});
            col.add_child(ellipsized(f.title, 'island-title island-ell-m2'));
            if (f.artist)
                col.add_child(ellipsized(f.artist, 'island-sub island-ell-m2'));
            row.add_child(col);
            row.add_child(iconButton('window-close-symbolic', () => this.ctx.removeFavorite(f.id), 'island-x', 12));
            this._body.add_child(row);
        }
    }

    _queue() {
        this._body.add_child(label('Loading…', 'island-sub'));
        const req = this._req;
        this.ctx.getQueue(list => {
            if (req !== this._req)
                return;
            this._body.destroy_all_children();
            if (list === null) {
                this._body.add_child(label('This player does not share its queue.', 'island-sub'));
                this._body.add_child(label('Spotify and browsers keep it private. VLC and similar players work.', 'island-sub'));
                return;
            }
            if (!list.length) {
                this._body.add_child(label('Nothing queued after this track.', 'island-sub'));
                return;
            }
            for (const t of list) {
                const col = new St.BoxLayout({vertical: true, style_class: 'island-frow-in'});
                col.add_child(ellipsized(t.title || 'Unknown', 'island-title island-ell-m2'));
                if (t.artist)
                    col.add_child(ellipsized(t.artist, 'island-sub island-ell-m2'));
                this._body.add_child(col);
            }
        });
    }

    _sleep() {
        const s = this.ctx.sleep;
        const t = label(s.running ? `Music pauses in ${fmtClock(s.remaining)}` : 'Pause music after…', 'island-title');
        t.set_x_align(CENTER);
        this._body.add_child(t);
        const chips = new St.BoxLayout({style_class: 'island-chips', x_align: CENTER});
        for (const m of SLEEP_PRESETS)
            chips.add_child(chip(`${m} min`, () => this.ctx.startSleep(m * 60)));
        this._body.add_child(chips);
        if (s.running) {
            const off = new St.BoxLayout({x_align: CENTER});
            off.add_child(chip('Cancel', () => this.ctx.cancelSleep()));
            this._body.add_child(off);
        }
    }
}

// card root

export class Card {
    constructor(ctx) {
        this.ctx = ctx;
        this._current = 'home';
        this.actor = new St.Widget({
            style_class: 'island-cardroot', layout_manager: new Clutter.BinLayout(), clip_to_allocation: true,
        });
        this.pages = {
            home: new HomePage(ctx, this),
            calendar: new CalendarPage(ctx, this),
            timer: new TimerPage(ctx, this),
            reminders: new RemindersPage(ctx, this),
            tray: new TrayPage(ctx, this),
            clipboard: new ClipboardPage(ctx, this),
            music: new MusicMenuPage(ctx, this),
        };
        for (const p of Object.values(this.pages)) {
            p.actor.set({x_expand: true, y_expand: true});
            p.actor.hide();
            this.actor.add_child(p.actor);
        }
    }

    get current() {
        return this._current;
    }

    show(name) {
        this._current = name;
        this.ctx.cardPageChanged?.();
        for (const [n, p] of Object.entries(this.pages)) {
            p.actor.remove_all_transitions();
            if (n === name) {
                p.actor.opacity = 0;
                p.actor.show();
                p.actor.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.LINEAR});
            } else {
                p.actor.hide();
            }
        }
        this.refresh();
    }

    tick() {
        try {
            this.pages[this._current]?.tick?.();
        } catch (e) {
            console.error(`island-notch: tick failed: ${e.message}`);
        }
    }

    refresh() {
        try {
            this.pages[this._current]?.refresh?.();
        } catch (e) {
            console.error(`island-notch: refreshing "${this._current}" failed: ${e.message}\n${e.stack}`);
        }
    }
}
