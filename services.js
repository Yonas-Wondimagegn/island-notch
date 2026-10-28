import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

let Gvc = null;
try {
    Gvc = (await import('gi://Gvc')).default;
} catch (_e) {
    Gvc = null;
}

let Soup = null;
try {
    Soup = (await import('gi://Soup?version=3.0')).default;
} catch (_e) {
    Soup = null;
}

const MPRIS = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const UPOWER = 'org.freedesktop.UPower';
const UPOWER_DISPLAY = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_DEVICE = 'org.freedesktop.UPower.Device';

function dbusCall(conn, dest, path, iface, method, args, replyType, cb) {
    conn.call(dest, path, iface, method, args,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE, 3000, null,
        (c, res) => {
            let reply = null;
            try {
                reply = c.call_finish(res);
            } catch (e) {
                cb?.(null, e);
                return;
            }
            cb?.(reply, null);
        });
}

// MPRIS

export class MprisWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._names = new Set();
        this._info = new Map();
        this._subs = [];
        this._refreshId = 0;
        this.current = null;

        const bus = Gio.DBus.session;

        this._subs.push(bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS))
                    return;
                if (newOwner) {
                    this._names.add(name);
                } else {
                    this._names.delete(name);
                    this._info.delete(name);
                }
                this._queueRefresh();
            }));

        this._subs.push(bus.signal_subscribe(
            null, PROPS_IFACE, 'PropertiesChanged', MPRIS_PATH, PLAYER_IFACE,
            Gio.DBusSignalFlags.NONE, () => this._queueRefresh()));

        dbusCall(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, '(as)', reply => {
                if (!reply)
                    return;
                for (const n of reply.deepUnpack()[0]) {
                    if (n.startsWith(MPRIS))
                        this._names.add(n);
                }
                this._queueRefresh();
            });
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        let pending = this._names.size;
        if (pending === 0) {
            this._pick();
            return;
        }
        for (const name of [...this._names]) {
            dbusCall(Gio.DBus.session, name, MPRIS_PATH, PROPS_IFACE, 'GetAll',
                new GLib.Variant('(s)', [PLAYER_IFACE]), '(a{sv})', reply => {
                    if (reply) {
                        const p = reply.recursiveUnpack()[0];
                        const md = p.Metadata ?? {};
                        const artist = md['xesam:artist'];
                        this._info.set(name, {
                            bus: name,
                            status: p.PlaybackStatus ?? 'Stopped',
                            title: md['xesam:title'] ?? '',
                            artist: Array.isArray(artist) ? artist.join(', ') : (artist ?? ''),
                            url: md['xesam:url'] ?? '',
                            album: md['xesam:album'] ?? '',
                            artUrl: md['mpris:artUrl'] ?? '',
                            length: Number(md['mpris:length'] ?? 0),
                            trackId: md['mpris:trackid'] ?? '',
                        });
                    } else {
                        this._info.delete(name);
                    }
                    if (--pending === 0)
                        this._pick();
                });
        }
    }

    _pick() {
        const all = [...this._info.values()];
        this.current =
            all.find(p => p.status === 'Playing') ??
            all.find(p => p.status === 'Paused') ??
            null;
        this._onChange();
    }

    control(method) {
        if (!this.current)
            return;
        dbusCall(Gio.DBus.session, this.current.bus, MPRIS_PATH, PLAYER_IFACE,
            method, null, null, null);
    }

    pauseAll() {
        for (const p of this._info.values()) {
            if (p.status === 'Playing')
                dbusCall(Gio.DBus.session, p.bus, MPRIS_PATH, PLAYER_IFACE, 'Pause', null, null, null);
        }
    }

    // track list
    getQueue(cb) {
        const c = this.current;
        if (!c) {
            cb(null);
            return;
        }
        const TL = 'org.mpris.MediaPlayer2.TrackList';
        dbusCall(Gio.DBus.session, c.bus, MPRIS_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [TL, 'Tracks']), '(v)', reply => {
                const ids = reply ? reply.recursiveUnpack()[0] : null;
                if (!Array.isArray(ids)) {
                    cb(null);
                    return;
                }
                const idx = ids.indexOf(c.trackId);
                const from = idx >= 0 ? idx + 1 : 0;
                const upcoming = ids.slice(from, from + 3);
                if (!upcoming.length) {
                    cb([]);
                    return;
                }
                dbusCall(Gio.DBus.session, c.bus, MPRIS_PATH, TL, 'GetTracksMetadata',
                    new GLib.Variant('(ao)', [upcoming]), '(aa{sv})', r2 => {
                        if (!r2) {
                            cb(null);
                            return;
                        }
                        cb(r2.recursiveUnpack()[0].map(md => ({
                            title: md['xesam:title'] ?? '',
                            artist: Array.isArray(md['xesam:artist'])
                                ? md['xesam:artist'].join(', ') : (md['xesam:artist'] ?? ''),
                        })));
                    });
            });
    }

    getPosition(cb) {
        if (!this.current) {
            cb(null);
            return;
        }
        dbusCall(Gio.DBus.session, this.current.bus, MPRIS_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), '(v)', reply => {
                cb(reply ? Number(reply.recursiveUnpack()[0]) : null);
            });
    }

    seek(frac) {
        const c = this.current;
        if (!c || !c.length || !c.trackId)
            return;
        try {
            dbusCall(Gio.DBus.session, c.bus, MPRIS_PATH, PLAYER_IFACE, 'SetPosition',
                new GLib.Variant('(ox)', [c.trackId, Math.floor(c.length * frac)]), null, null);
        } catch (_e) { // bad track
        }
    }

    openUri(url) {
        const spotify = [...this._names].find(n => n.toLowerCase().includes('spotify'));
        if (spotify && /spotify/i.test(url)) {
            dbusCall(Gio.DBus.session, spotify, MPRIS_PATH, PLAYER_IFACE, 'OpenUri',
                new GLib.Variant('(s)', [url]), null, null);
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            console.error(`island-notch: cannot open ${url}: ${e.message}`);
        }
    }

    destroy() {
        for (const id of this._subs)
            Gio.DBus.session.signal_unsubscribe(id);
        this._subs = [];
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
    }
}

// power

const isPlugged = s => s === 1 || s === 4 || s === 5;

export class PowerWatcher {
    constructor(onEvent, onUpdate) {
        this._onEvent = onEvent;
        this._onUpdate = onUpdate;
        this.percentage = null;
        this.state = null;
        this._sub = Gio.DBus.system.signal_subscribe(
            UPOWER, PROPS_IFACE, 'PropertiesChanged', UPOWER_DISPLAY, UPOWER_DEVICE,
            Gio.DBusSignalFlags.NONE, () => this._read(false));
        this._read(true);
    }

    get charging() {
        return isPlugged(this.state);
    }

    _read(initial) {
        dbusCall(Gio.DBus.system, UPOWER, UPOWER_DISPLAY, PROPS_IFACE, 'GetAll',
            new GLib.Variant('(s)', [UPOWER_DEVICE]), '(a{sv})', reply => {
                if (!reply)
                    return;
                const p = reply.recursiveUnpack()[0];
                const pct = Math.round(p.Percentage ?? 0);
                const st = p.State ?? 0;
                const prevState = this.state;
                const prevPct = this.percentage;
                this.state = st;
                this.percentage = pct;
                this._onUpdate?.();
                if (initial || prevState === null)
                    return;

                if (isPlugged(st) && !isPlugged(prevState))
                    this._onEvent('plugged', pct);
                else if (!isPlugged(st) && isPlugged(prevState))
                    this._onEvent('unplugged', pct);
                else if (st === 4 && prevState !== 4)
                    this._onEvent('full', pct);
                else if (st === 2 && prevPct !== null) {
                    if (pct <= 10 && prevPct > 10)
                        this._onEvent('critical', pct);
                    else if (pct <= 20 && prevPct > 20)
                        this._onEvent('low', pct);
                }
            });
    }

    destroy() {
        if (this._sub)
            Gio.DBus.system.signal_unsubscribe(this._sub);
        this._sub = 0;
    }
}

// reminders

export class ReminderStore {
    constructor(onDue) {
        this._onDue = onDue;
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'island-notch']);
        this._file = GLib.build_filenamev([this._dir, 'reminders.json']);
        this._items = [];
        this._load();
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _load() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._file);
            if (ok)
                this._items = JSON.parse(new TextDecoder().decode(bytes));
        } catch (_e) {
            this._items = [];
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this._file, JSON.stringify(this._items));
        } catch (e) {
            console.error(`island-notch: could not save reminders: ${e.message}`);
        }
    }

    list() {
        return [...this._items].sort((a, b) => a.due - b.due);
    }

    add(text, due) {
        this._items.push({id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, text, due});
        this._save();
    }

    remove(id) {
        this._items = this._items.filter(i => i.id !== id);
        this._save();
    }

    _check() {
        const now = Date.now();
        const due = this._items.filter(i => i.due <= now);
        if (!due.length)
            return;
        this._items = this._items.filter(i => i.due > now);
        this._save();
        due.forEach(d => this._onDue(d));
    }

    destroy() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}

// timer

export class CountdownTimer {
    constructor(onTick, onDone) {
        this._onTick = onTick;
        this._onDone = onDone;
        this.total = 0;
        this.remaining = 0;
        this.running = false;
        this._endAt = 0;
        this._id = 0;
    }

    _now() {
        return GLib.get_monotonic_time() / 1e6;
    }

    start(seconds) {
        this.total = seconds;
        this.remaining = seconds;
        this._resume();
    }

    _resume() {
        this._stopSource();
        this._endAt = this._now() + this.remaining;
        this.running = true;
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this.remaining = Math.max(0, Math.ceil(this._endAt - this._now()));
            if (this.remaining <= 0) {
                this._id = 0;
                this.running = false;
                this._onTick();
                this._onDone();
                return GLib.SOURCE_REMOVE;
            }
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    toggle() {
        if (this.running) {
            this.remaining = Math.max(0, Math.ceil(this._endAt - this._now()));
            this._stopSource();
            this.running = false;
        } else if (this.remaining > 0) {
            this._resume();
        }
    }

    reset() {
        this._stopSource();
        this.running = false;
        this.remaining = 0;
        this.total = 0;
    }

    _stopSource() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }

    destroy() {
        this._stopSource();
    }
}

// JSON lists

export class JsonList {
    constructor(filename) {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'island-notch']);
        this._file = GLib.build_filenamev([this._dir, filename]);
        this.items = [];
        try {
            const [ok, bytes] = GLib.file_get_contents(this._file);
            if (ok)
                this.items = JSON.parse(new TextDecoder().decode(bytes));
        } catch (_e) {
            this.items = [];
        }
    }

    save() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this._file, JSON.stringify(this.items));
        } catch (e) {
            console.error(`island-notch: could not save ${this._file}: ${e.message}`);
        }
    }

    add(item, same) {
        if (this.items.some(i => same(i, item)))
            return false;
        this.items.push(item);
        this.save();
        return true;
    }

    removeWhere(pred) {
        this.items = this.items.filter(i => !pred(i));
        this.save();
    }

    clear() {
        this.items = [];
        this.save();
    }
}

// audio + clip

export class VolumeWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._stream = null;
        this._streamIds = [];
        this._ids = [];
        this._mixer = null;
        if (!Gvc)
            return;
        this._mixer = new Gvc.MixerControl({name: 'Island Notch'});
        this._ids.push(this._mixer.connect('default-sink-changed', () => this._bind()));
        this._ids.push(this._mixer.connect('state-changed', () => this._bind()));
        this._mixer.open();
    }

    _unbind() {
        for (const id of this._streamIds) {
            try {
                this._stream.disconnect(id);
            } catch (_e) { // gone
            }
        }
        this._streamIds = [];
        this._stream = null;
    }

    _bind() {
        const s = this._mixer.get_default_sink();
        if (!s || s === this._stream)
            return;
        this._unbind();
        this._stream = s;
        this._streamIds = [
            s.connect('notify::volume', () => this._emit()),
            s.connect('notify::is-muted', () => this._emit()),
        ];
    }

    _emit() {
        const max = this._mixer.get_vol_max_norm() || 65536;
        this._onChange(this._stream.volume / max, this._stream.is_muted);
    }

    destroy() {
        this._unbind();
        for (const id of this._ids)
            this._mixer?.disconnect(id);
        this._ids = [];
        try {
            this._mixer?.close();
        } catch (_e) { // ignore
        }
        this._mixer = null;
    }
}

export class BrightnessWatcher {
    constructor(onChange) {
        this._sub = Gio.DBus.session.signal_subscribe(
            'org.gnome.SettingsDaemon.Power', PROPS_IFACE, 'PropertiesChanged',
            '/org/gnome/SettingsDaemon/Power', 'org.gnome.SettingsDaemon.Power.Screen',
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
                const [, changed] = params.recursiveUnpack();
                if (changed && typeof changed.Brightness === 'number' && changed.Brightness >= 0)
                    onChange(changed.Brightness / 100);
            });
    }

    destroy() {
        if (this._sub)
            Gio.DBus.session.signal_unsubscribe(this._sub);
        this._sub = 0;
    }
}

/*
 * Recent copies are kept in memory only and vanish when you log out.
 * Pinned snippets are saved to ~/.local/share/island-notch/pins.json so they survive restarts.
 */
export class ClipboardHistory {
    constructor(onChange) {
        this._onChange = onChange;
        this._pins = new JsonList('pins.json');
        this.recent = [];
        this._last = null;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _isPinned(text) {
        return this._pins.items.some(p => p.text === text);
    }

    entries() {
        return [
            ...this._pins.items.map(p => ({text: p.text, pinned: true})),
            ...this.recent.filter(t => !this._isPinned(t)).map(t => ({text: t, pinned: false})),
        ];
    }

    _poll() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (!text || text === this._last)
                return;
            this._last = text;
            if (this._isPinned(text))
                return;
            this.recent = [text.slice(0, 2000), ...this.recent.filter(t => t !== text)].slice(0, 8);
            this._onChange();
        });
    }

    pin(text) {
        this._pins.add({text}, (a, b) => a.text === b.text);
        this._onChange();
    }

    unpin(text) {
        this._pins.removeWhere(p => p.text === text);
        this._onChange();
    }

    remove(text) {
        this.recent = this.recent.filter(t => t !== text);
        this._pins.removeWhere(p => p.text === text);
        this._onChange();
    }

    clearUnpinned() {
        this.recent = [];
        this._onChange();
    }

    copy(text) {
        this._last = text;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    destroy() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}

// lyrics

const LRC_STAMP = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
const LRC_ANY = /\[(?:\d+:\d+(?:\.\d+)?|(?:ar|ti|al|au|by|offset|re|ve|length|tool):[^\]]*)\]/gi;

// LRC parse
export function parseLrc(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
        const stamps = [...line.matchAll(LRC_STAMP)];
        if (!stamps.length)
            continue;
        const txt = line.replace(LRC_ANY, '').trim();
        for (const m of stamps)
            out.push({t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text: txt});
    }
    return out.sort((a, b) => a.t - b.t);
}

// lyric lookup
export class LyricsFetcher {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'island-notch', 'lyrics']);
        this._session = Soup ? new Soup.Session({timeout: 10}) : null;
        this._cancel = new Gio.Cancellable();
        this._cleanup();
    }

    _cleanup() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            if (!dir.query_exists(null))
                return;
            const cutoff = Date.now() / 1000 - 60 * 86400;
            const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                if (info.get_attribute_uint64('time::modified') < cutoff)
                    dir.get_child(info.get_name()).delete(null);
            }
        } catch (_e) { // best effort
        }
    }

    _sidecar(url) {
        try {
            if (!url || !url.startsWith('file://'))
                return null;
            const path = Gio.File.new_for_uri(url).get_path();
            if (!path)
                return null;
            const lrc = path.replace(/\.[^./]+$/, '.lrc');
            if (!GLib.file_test(lrc, GLib.FileTest.EXISTS))
                return null;
            const [ok, bytes] = GLib.file_get_contents(lrc);
            if (!ok)
                return null;
            const synced = parseLrc(new TextDecoder().decode(bytes));
            return synced.length ? {synced, plain: ''} : null;
        } catch (_e) {
            return null;
        }
    }

    // cache state
    _readCache(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return undefined;
            const o = JSON.parse(new TextDecoder().decode(bytes));
            if (o.res)
                return o.res;
            if (Date.now() - o.t < 86400 * 1000)
                return null;
        } catch (_e) { // no cache
        }
        return undefined;
    }

    _writeCache(path, res) {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(path, new TextEncoder().encode(JSON.stringify({t: Date.now(), res})));
        } catch (_e) { // best effort
        }
    }

    _request(url, cb) {
        const msg = Soup ? Soup.Message.new('GET', url) : null;
        if (!msg) {
            cb(null);
            return;
        }
        msg.get_request_headers().append('User-Agent', 'island-notch/1 (GNOME Shell extension)');
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancel, (s, res) => {
            let data = null;
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() === 200)
                    data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                console.error(`island-notch: lyrics request failed: ${e.message}`);
            }
            cb(data);
        });
    }

    // online fetch
    _online(m, cb) {
        if (!this._session || !m.title) {
            cb(null, false);
            return;
        }
        const enc = encodeURIComponent;
        const artist = (m.artist || '').split(',')[0].trim();
        const secs = Math.round((m.length || 0) / 1e6);
        const pick = j => {
            if (!j || j.instrumental)
                return null;
            const synced = j.syncedLyrics ? parseLrc(j.syncedLyrics) : [];
            const plain = j.plainLyrics ?? '';
            return synced.length || plain ? {synced, plain} : null;
        };
        const search = () => this._request(
            `https://lrclib.net/api/search?track_name=${enc(m.title)}&artist_name=${enc(artist)}`, arr => {
                if (!Array.isArray(arr)) {
                    cb(null, false);
                    return;
                }
                const near = secs ? arr.filter(x => Math.abs((x.duration ?? 0) - secs) <= 3) : arr;
                const best = near.find(x => x.syncedLyrics) ?? near.find(x => x.plainLyrics);
                cb(best ? pick(best) : null, true);
            });
        if (m.album && secs) {
            this._request('https://lrclib.net/api/get' +
                `?artist_name=${enc(artist)}&track_name=${enc(m.title)}&album_name=${enc(m.album)}&duration=${secs}`,
            j => {
                const r = pick(j);
                if (r)
                    cb(r, true);
                else
                    search();
            });
        } else {
            search();
        }
    }

    get(m, cb) {
        const side = this._sidecar(m.url);
        if (side) {
            cb(side);
            return;
        }
        const secs = Math.round((m.length || 0) / 1e6);
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
            `${m.artist}|${m.title}|${m.album}|${secs}`, -1);
        const path = GLib.build_filenamev([this._dir, `${key}.json`]);
        const cached = this._readCache(path);
        if (cached !== undefined) {
            cb(cached);
            return;
        }
        this._online(m, (res, definitive) => {
            if (definitive)
                this._writeCache(path, res);
            cb(res);
        });
    }

    destroy() {
        try {
            this._cancel.cancel();
            this._session?.abort();
        } catch (_e) { // ignore
        }
    }
}

// cover art

export class ArtCache {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'island-notch', 'art']);
        this._session = Soup ? new Soup.Session({timeout: 10}) : null;
        this._timers = new Set();
        this._cleanup();
    }

    _cleanup() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            if (!dir.query_exists(null))
                return;
            const cutoff = Date.now() / 1000 - 14 * 86400;
            const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                if (info.get_attribute_uint64('time::modified') < cutoff)
                    dir.get_child(info.get_name()).delete(null);
            }
        } catch (_e) { // best effort
        }
    }

    // local cache
    _local(src, tries, cb) {
        try {
            const f = Gio.File.new_for_path(src);
            const info = f.query_info('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_size() > 0) {
                const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
                    `${src}|${info.get_attribute_uint64('time::modified')}|${info.get_size()}`, -1);
                const dst = GLib.build_filenamev([this._dir, key]);
                if (!GLib.file_test(dst, GLib.FileTest.EXISTS)) {
                    GLib.mkdir_with_parents(this._dir, 0o755);
                    f.copy(Gio.File.new_for_path(dst), Gio.FileCopyFlags.OVERWRITE, null, null);
                }
                cb(dst);
                return;
            }
        } catch (_e) { // not there yet
        }
        if (!src || tries >= 10) {
            cb(null);
            return;
        }
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._timers.delete(id);
            this._local(src, tries + 1, cb);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    // resolve art
    resolve(url, cb) {
        if (!url) {
            cb(null);
            return;
        }
        if (url.startsWith('file://')) {
            let src = null;
            try { src = Gio.File.new_for_uri(url).get_path(); } catch (_e) { // bad uri
            }
            this._local(src, 0, cb);
            return;
        }
        if (!/^https?:/.test(url) || !this._session) {
            cb(null);
            return;
        }
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([this._dir, key]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            cb(path);
            return;
        }
        const msg = Soup.Message.new('GET', url);
        if (!msg) {
            cb(null);
            return;
        }
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() === 200 && bytes.get_size() > 0) {
                    GLib.mkdir_with_parents(this._dir, 0o755);
                    GLib.file_set_contents(path, bytes.get_data());
                    cb(path);
                    return;
                }
            } catch (e) {
                console.error(`island-notch: cover download failed: ${e.message}`);
            }
            cb(null);
        });
    }

    destroy() {
        for (const id of this._timers) {
            try { GLib.source_remove(id); } catch (_e) { // ignore
            }
        }
        this._timers.clear();
        try {
            this._session?.abort();
        } catch (_e) { // ignore
        }
    }
}
