import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Pango from "gi://Pango";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  MprisWatcher,
  PowerWatcher,
  ReminderStore,
  CountdownTimer,
  JsonList,
  VolumeWatcher,
  BrightnessWatcher,
  ClipboardHistory,
  ArtCache,
  LyricsFetcher,
} from "./services.js";
import { label, icon, plain, dbg, fmtClock, setCover } from "./widgets.js";
import { Card } from "./pages.js";
import { Strips } from "./strips.js";

// pill clock
const SHOW_CLOCK_IN_PILL = true;
const FLOAT_Y = 8;

// hover timing
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 220;

// mode sizes
const MODES = {
  idle: { w: 150, h: 32, r: 16, float: false },
  media: { w: 240, h: 32, r: 16, float: false },
  peek: { w: 390, h: 62, r: 31, float: false },
  osd: { w: 330, h: 46, r: 23, float: false },
  card: { w: 440, h: 200, r: 34, float: false },
};

// card height
const CARD_H = 200;
const LYRICS_H = 68;

const COLOR = { timer: "#ff9f0a", power: "#30d158", red: "#ff453a" };

export class Island {
  constructor() {
    this._sigs = [];
    this._timers = new Map();
    this._mode = "idle";
    this._typing = false;
    this._grab = null;
    this._media = null;
    this._mediaSeen = false;
    this._lastTrack = null;
    this._peekAction = null;
    this._outsideId = 0;
    this._barW = 90;
    this._barH = 32;
    this._artUrl = "";
    this._artPath = null;
    this._cArtPath = null;
    this._pos = 0;
    this._posKnown = false;
    this._posKey = null;
    this._posMs = 0;
    this._lyrics = null;
    this._lyricsKey = null;
    this._showMusicTime = false;
    this._clockText = "";
    this._pillText = null;
  }

  enable() {
    this._iface = new Gio.Settings({
      schema_id: "org.gnome.desktop.interface",
    });
    this._notif = new Gio.Settings({
      schema_id: "org.gnome.desktop.notifications",
    });

    this._barH = Math.max(
      28,
      Math.min(42, Math.round(Main.panel.get_height()) || 32),
    );
    MODES.idle.h = MODES.media.h = this._barH;
    MODES.idle.r = MODES.media.r = Math.round(this._barH / 2);

    this._favorites = new JsonList("favorites.json");
    this._tray = new JsonList("tray.json");
    this._timer = new CountdownTimer(
      () => this._onTimerTick(),
      () => this._onTimerDone(),
    );
    this._reminders = new ReminderStore((r) => this._onReminderDue(r));
    this._clip = new ClipboardHistory(() => this._refreshCard());
    this._artCache = new ArtCache();
    this._lyricsFetcher = new LyricsFetcher();
    this._sleep = new CountdownTimer(
      () => this._onSleepTick(),
      () => this._onSleepDone(),
    );

    this._ctx = this._makeContext();
    this._buildUi();
    this._addChrome();
    this._dimPanel();
    this._hookOsd();
    this._hookNotifications();

    this._strips = new Strips({
      barH: this._barH,
      onOverview: () => Main.overview.toggle(),
      onQuickSettings: () => this._toggleQuickSettings(),
      onDate: () => this._openCard("calendar"),
      iface: this._iface,
      notif: this._notif,
    });

    this._mpris = new MprisWatcher(() => this._onMedia());
    this._power = new PowerWatcher(
      (k, p) => this._onPower(k, p),
      () => this._onPowerUpdate(),
    );
    this._volume = new VolumeWatcher((lvl, muted) =>
      this._onVolume(lvl, muted),
    );
    this._brightness = new BrightnessWatcher((lvl) => this._onBrightness(lvl));

    this._every("clock", 1000, () => this._tickClock());
    this._tickClock();
    this._refreshCompact();
    this._setMode("idle", true);
    dbg(`enabled (bar height ${this._barH})`);
  }

  destroy() {
    this._endTyping();
    this._watchOutside(false);
    for (const key of [...this._timers.keys()]) this._clear(key);
    for (const [obj, id] of this._sigs) {
      try {
        obj.disconnect(id);
      } catch (_e) {}
    }
    this._sigs = [];

    this._unhookOsd();
    this._unhookNotifications();
    this._restorePanel();

    this._strips?.destroy();
    this._mpris?.destroy();
    this._power?.destroy();
    this._volume?.destroy();
    this._brightness?.destroy();
    this._timer?.destroy();
    this._reminders?.destroy();
    this._clip?.destroy();
    this._artCache?.destroy();
    this._lyricsFetcher?.destroy();
    this._sleep?.destroy();

    if (this.actor) {
      Main.layoutManager.removeChrome(this.actor);
      this.actor.destroy();
      this.actor = null;
    }
  }

  _connect(obj, name, cb) {
    const id = obj.connect(name, cb);
    this._sigs.push([obj, id]);
    return id;
  }

  _clear(key) {
    const id = this._timers.get(key);
    if (id) GLib.source_remove(id);
    this._timers.delete(key);
  }

  _after(key, ms, fn) {
    this._clear(key);
    this._timers.set(
      key,
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        this._timers.delete(key);
        fn();
        return GLib.SOURCE_REMOVE;
      }),
    );
  }

  _every(key, ms, fn) {
    this._clear(key);
    this._timers.set(
      key,
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_CONTINUE;
      }),
    );
  }

  _makeContext() {
    const self = this;
    return {
      get mpris() {
        return self._mpris;
      },
      get timer() {
        return self._timer;
      },
      get clipboard() {
        return self._clip;
      },
      reminders: this._reminders,
      favorites: this._favorites,
      tray: this._tray,
      media: () => this._media,
      collapse: () => this._collapse(),
      overview: () => {
        this._collapse();
        Main.overview.toggle();
      },
      lock: () => {
        this._collapse();
        Main.screenShield.lock(true);
      },
      toggleQuickSettings: () => this._toggleQuickSettings(),
      toggleDnd: () => this._toggleDnd(),
      isDnd: () => !this._notif.get_boolean("show-banners"),
      startTimer: (s) => this._startTimer(s),
      toggleTimer: () => this._toggleTimer(),
      resetTimer: () => this._resetTimer(),
      addReminder: (t, due) => this._addReminder(t, due),
      artPath: () => this._artPath,
      lyrics: () => this._lyrics,
      cardPageChanged: () => this._fitCard(),
      get sleep() {
        return self._sleep;
      },
      startSleep: (sec) => {
        this._sleep.start(sec);
        this._refreshCard();
      },
      cancelSleep: () => {
        this._sleep.reset();
        this._refreshCard();
      },
      getQueue: (cb) => this._mpris.getQueue(cb),
      removeReminder: (id) => {
        this._reminders.remove(id);
        this._refreshCard();
      },
      beginTyping: () => this._beginTyping(),
      toggleFavorite: () => this._toggleFavorite(),
      isFavorite: (m) =>
        !!m && this._favorites.items.some((f) => this._sameTrack(f, m)),
      playFavorite: (f) => {
        this._mpris.openUri(f.url);
        this._collapse();
      },
      removeFavorite: (id) => {
        this._favorites.removeWhere((f) => f.id === id);
        this._refreshCard();
      },
    };
  }

  _buildUi() {
    this.actor = new St.Widget({
      name: "island",
      style_class: "island",
      reactive: true,
      track_hover: true,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
    });

    this._compact = this._buildCompact();
    this._peek = this._buildPeek();

    this._card = new Card(this._ctx);
    this._cardView = this._card.actor;
    this._cardView.set_size(MODES.card.w, MODES.card.h);
    this._cardView.set({
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
    });

    this._views = [this._compact, this._peek, this._cardView];
    for (const v of this._views) {
      v.opacity = 0;
      v.hide();
      this.actor.add_child(v);
    }

    this._connect(this.actor, "notify::hover", () =>
      this._onHover(this.actor.hover),
    );
    this._connect(this.actor, "button-press-event", () => {
      if (this._mode === "idle" || this._mode === "media") {
        this._clear("hover");
        this._openCard("home");
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
    this._connect(this.actor, "key-press-event", (_a, ev) => {
      if (ev.get_key_symbol() === Clutter.KEY_Escape && this._typing) {
        this._collapse();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
    this._connect(this.actor, "captured-event", (_a, ev) => {
      if (!this._typing || ev.type() !== Clutter.EventType.BUTTON_PRESS)
        return Clutter.EVENT_PROPAGATE;
      if (this._outside(ev)) {
        this._collapse();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
  }

  _outside(ev) {
    const [x, y] = ev.get_coords();
    const [ax, ay] = this.actor.get_transformed_position();
    const [aw, ah] = this.actor.get_transformed_size();
    return x < ax || x > ax + aw || y < ay || y > ay + ah;
  }

  _watchOutside(on) {
    if (on && !this._outsideId) {
      this._outsideId = global.stage.connect("captured-event", (_s, ev) => {
        if (
          ev.type() === Clutter.EventType.BUTTON_PRESS &&
          this._mode === "card" &&
          this._outside(ev)
        )
          this._collapse();
        return Clutter.EVENT_PROPAGATE;
      });
    } else if (!on && this._outsideId) {
      global.stage.disconnect(this._outsideId);
      this._outsideId = 0;
    }
  }

  _buildCompact() {
    const root = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });
    const box = new St.BoxLayout({
      style_class: "island-compact",
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });

    const left = new St.BoxLayout({
      style_class: "island-slot",
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._cArt = new St.Bin({
      style_class: "island-cart",
      clip_to_allocation: true,
      y_align: Clutter.ActorAlign.CENTER,
      child: icon("audio-x-generic-symbolic", 13, "island-music-icon"),
    });
    left.add_child(this._cArt);

    this._cTime = label("", "island-time");
    this._cTime.set({ x_expand: true, x_align: Clutter.ActorAlign.CENTER });

    const right = new St.BoxLayout({
      style_class: "island-slot",
      x_align: Clutter.ActorAlign.END,
    });
    this._bars = [0, 1, 2].map(() => {
      const b = new St.Widget({
        style_class: "island-bar",
        y_align: Clutter.ActorAlign.CENTER,
      });
      b.set_height(6);
      return b;
    });
    this._cBars = new St.BoxLayout({
      style_class: "island-bars",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._bars.forEach((b) => this._cBars.add_child(b));
    this._cTimer = label("", "island-mini-timer");
    right.add_child(this._cBars);
    right.add_child(this._cTimer);

    box.add_child(left);
    box.add_child(this._cTime);
    box.add_child(right);

    this._pillTrack = new St.Widget({
      style_class: "island-pilltrack",
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.END,
    });
    this._pillTrack.set_height(3);
    this._pillFill = new St.Widget({ style_class: "island-pillfill" });
    this._pillFill.set_size(0, 3);
    this._pillTrack.add_child(this._pillFill);
    this._pillTrack.hide();

    root.add_child(box);
    root.add_child(this._pillTrack);
    return root;
  }

  _buildPeek() {
    const CENTER = Clutter.ActorAlign.CENTER;
    const box = new St.BoxLayout({
      style_class: "island-peek",
      reactive: true,
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });
    const inner = new St.BoxLayout({
      style_class: "island-peek-inner",
      x_expand: true,
      y_expand: true,
      x_align: CENTER,
      y_align: CENTER,
    });

    this._pIcon = new St.Icon({
      icon_size: 24,
      style_class: "island-peek-icon",
      y_align: CENTER,
    });
    this._pCover = new St.Bin({
      style_class: "island-pcover",
      y_align: CENTER,
      child: icon("audio-x-generic-symbolic", 18, "island-music-icon"),
    });
    this._pCover.hide();

    const col = new St.BoxLayout({ vertical: true, y_align: CENTER });
    this._pTitle = label("", "island-title island-ell-wide");
    this._pTitle.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._pTitle.set_x_align(CENTER);
    this._pSub = label("", "island-sub island-ell-wide");
    this._pSub.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._pSub.set_x_align(CENTER);
    col.add_child(this._pTitle);
    col.add_child(this._pSub);

    this._pTrack = new St.Widget({
      style_class: "island-track",
      y_align: CENTER,
    });
    this._pTrack.set_size(this._barW, 6);
    this._pFill = new St.Widget({ style_class: "island-fill" });
    this._pFill.set_size(0, 6);
    this._pTrack.add_child(this._pFill);

    inner.add_child(this._pIcon);
    inner.add_child(this._pCover);
    inner.add_child(col);
    inner.add_child(this._pTrack);
    box.add_child(inner);

    box.connect("button-press-event", () => {
      if (this._peekAction) {
        this._peekAction();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
    return box;
  }

  _addChrome() {
    Main.layoutManager.addTopChrome(this.actor, {
      affectsStruts: false,
      trackFullscreen: true,
    });
    this._connect(Main.layoutManager, "monitors-changed", () => {
      this._strips?.reposition();
      this._setMode(this._mode, true);
    });
  }

  // panel hide
  _dimPanel() {
    Main.panel.set_opacity(0);
  }

  _restorePanel() {
    Main.panel.set_opacity(255);
  }

  _toggleQuickSettings() {
    this._collapse();
    const qs = Main.panel.statusArea?.quickSettings;
    if (!qs) {
      dbg("quickSettings indicator not found");
      return;
    }
    qs.menu.toggle();
  }

  _baseMode() {
    const playing = this._media?.status === "Playing";
    return playing || this._timer?.running ? "media" : "idle";
  }

  _syncBase() {
    if (this._mode === "idle" || this._mode === "media") {
      const base = this._baseMode();
      if (base !== this._mode) this._setMode(base);
    }
  }

  _shape(spec) {
    this.actor.set_style(
      spec.float
        ? `border-radius: ${spec.r}px;`
        : `border-radius: 0px 0px ${spec.r}px ${spec.r}px;`,
    );
    if (spec.float) this.actor.add_style_class_name("island-glass");
    else this.actor.remove_style_class_name("island-glass");
  }

  _viewFor(mode) {
    if (mode === "card") return this._cardView;
    if (mode === "peek" || mode === "osd") return this._peek;
    return this._compact;
  }

  _setMode(mode, instant = false) {
    const spec = MODES[mode];
    const mon = Main.layoutManager.primaryMonitor;
    const x = Math.round(mon.x + (mon.width - spec.w) / 2);
    const y = mon.y + (spec.float ? FLOAT_Y : 0);
    const growing = spec.h >= (this.actor.height || 0);
    this._mode = mode;

    if (growing || instant || spec.float) this._shape(spec);

    this.actor.remove_all_transitions();
    if (instant) {
      this.actor.set({ x, y, width: spec.w, height: spec.h });
    } else {
      this.actor.ease({
        x,
        y,
        width: spec.w,
        height: spec.h,
        duration: mode === "card" ? 300 : 260,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onComplete: () => {
          if (this._mode === mode) this._shape(spec);
        },
      });
    }
    this._showView(this._viewFor(mode), instant);
    this._watchOutside(mode === "card");
    if (mode === "card") this._card.refresh();
    this._refreshCompact();
    this._updatePolling();
  }

  _updatePolling() {
    const playing = this._media?.status === "Playing";
    const want = playing || (this._mode === "card" && this._media);
    const fast =
      playing &&
      this._mode === "card" &&
      this._card.current === "home" &&
      !!this._lyrics?.synced.length;
    const ms = fast ? 250 : 1000;
    if (want && (!this._timers.has("pos") || this._posMs !== ms)) {
      this._posMs = ms;
      this._every("pos", ms, () => this._pollPosition());
      this._pollPosition();
    } else if (!want) {
      this._clear("pos");
    }
  }

  _pollPosition() {
    this._mpris?.getPosition((p) => {
      if (!this.actor) return;
      if (p === null) {
        this._posKnown = false;
        return;
      }
      this._pos = p;
      this._posKnown = true;
      this._refreshCompact();
      if (this._mode === "card") this._card.pages.home.setPosition(p);
    });
  }

  _showView(view, instant) {
    for (const v of this._views) {
      v.remove_all_transitions();
      if (v === view) {
        v.show();
        if (instant) v.opacity = 255;
        else
          v.ease({
            opacity: 255,
            duration: 200,
            delay: 90,
            mode: Clutter.AnimationMode.LINEAR,
          });
      } else if (v.visible) {
        if (instant) {
          v.opacity = 0;
          v.hide();
        } else {
          v.ease({
            opacity: 0,
            duration: 110,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => {
              if (v !== this._viewNow) v.hide();
            },
          });
        }
      }
    }
    this._viewNow = view;
  }

  // hover card
  _onHover(hover) {
    this._clear("hover");
    if (hover) {
      if (this._mode === "idle" || this._mode === "media")
        this._after("hover", HOVER_OPEN_MS, () => this._openCard("home"));
    } else if (this._mode === "card" && !this._typing) {
      this._after("hover", HOVER_CLOSE_MS, () => this._collapse());
    }
  }

  _openCard(page = "home") {
    this._clear("hover");
    this._clear("activity");
    this._card.show(page);
    this._setMode("card");
  }

  _collapse() {
    this._endTyping();
    this._clear("hover");
    this._setMode(this._baseMode());
  }

  _refreshCard() {
    if (this._mode === "card") this._card.refresh();
    this._updatePolling();
  }

  // lyrics height
  _fitCard() {
    const has = !!(
      this._lyrics &&
      (this._lyrics.synced.length || this._lyrics.plain)
    );
    const h = this._card.current === "home" && has ? CARD_H + LYRICS_H : CARD_H;
    if (MODES.card.h !== h) {
      MODES.card.h = h;
      this._cardView.set_size(MODES.card.w, h);
      if (this._mode === "card") this._setMode("card");
    }
    this._updatePolling();
  }

  _activity({
    icon: iconName,
    gicon,
    title,
    sub = "",
    level = null,
    color = COLOR.power,
    ms = 2800,
    action = null,
    mode = "peek",
    force = false,
    track = false,
    coverPath = null,
  }) {
    if (this._mode === "card") {
      if (!force) return;
      this._endTyping();
    }
    this._peekTrack = track;
    this._pCover.visible = track;
    this._pIcon.visible = !track;
    if (track) setCover(this._pCover, coverPath, 18);
    else
      this._pIcon.set_gicon(
        gicon ??
          new Gio.ThemedIcon({
            name: iconName ?? "dialog-information-symbolic",
          }),
      );
    this._pTitle.set_text(title ?? "");
    this._pSub.set_text(sub ?? "");
    this._pSub.visible = !!sub;
    this._peekAction = action;
    this._barW = mode === "osd" ? 130 : 90;
    if (level === null) {
      this._pTrack.hide();
    } else {
      this._pTrack.show();
      this._pTrack.set_width(this._barW);
      this._pFill.set_style(`background-color: ${color};`);
      this._pFill.remove_all_transitions();
      this._pFill.ease({
        width: Math.round(this._barW * Math.max(0, Math.min(1, level))),
        duration: 160,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }
    if (this._mode !== mode) this._setMode(mode);
    this._after("activity", ms, () => this._endActivity());
  }

  _endActivity() {
    this._peekAction = null;
    this._peekTrack = false;
    if (this._mode === "peek" || this._mode === "osd")
      this._setMode(this._baseMode());
  }

  _onVolume(level, muted) {
    dbg(`volume ${Math.round(level * 100)}% muted=${muted}`);
    this._strips?.setVolume(level, muted);
    let name = "audio-volume-high-symbolic";
    if (muted || level <= 0) name = "audio-volume-muted-symbolic";
    else if (level < 0.34) name = "audio-volume-low-symbolic";
    else if (level < 0.67) name = "audio-volume-medium-symbolic";
    this._activity({
      icon: name,
      title: "Sound",
      level: muted ? 0 : Math.min(1, level),
      color: "#ffffff",
      ms: 1600,
      mode: "osd",
    });
  }

  _onBrightness(level) {
    dbg(`brightness ${Math.round(level * 100)}%`);
    this._activity({
      icon: "display-brightness-symbolic",
      title: "Brightness",
      level: Math.min(1, level),
      color: "#ffffff",
      ms: 1600,
      mode: "osd",
    });
  }

  // osd bridge
  _hookOsd() {
    const mgr = Main.osdWindowManager;
    const names = new Set();
    for (
      let o = mgr;
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o)
    ) {
      for (const n of Object.getOwnPropertyNames(o)) {
        if (/^show/.test(n) && typeof mgr[n] === "function") names.add(n);
      }
    }
    this._osdWrapped = [];
    for (const name of names) {
      const original = mgr[name];
      const hasMonitor = name !== "showAll";
      mgr[name] = (...args) => {
        try {
          const [gicon, text, level, maxLevel] = hasMonitor
            ? args.slice(1)
            : args;
          this._onOsd(gicon, text, level, maxLevel);
        } catch (e) {
          console.error(`island-notch: OSD fallback (${name}): ${e.message}`);
          return original.apply(mgr, args);
        }
        return undefined;
      };
      this._osdWrapped.push(name);
    }
    dbg(`OSD hooks installed on: ${[...names].join(", ") || "nothing found"}`);
  }

  _unhookOsd() {
    for (const name of this._osdWrapped ?? {}) {
      try {
        delete Main.osdWindowManager[name];
      } catch (_e) {}
    }
    this._osdWrapped = [];
  }

  _onOsd(gicon, text, level, maxLevel) {
    const name = gicon?.names?.[0] ?? "";
    dbg(`stock OSD: icon=${name} label=${text} level=${level}`);
    let title = text ?? "";
    if (name.includes("microphone")) title = "Microphone";
    else if (name.includes("audio-volume")) title = "Sound";
    else if (name.includes("brightness")) title = "Brightness";
    else if (name.includes("keyboard")) title = "Keyboard light";

    const max = maxLevel || 1;
    const hasLevel = level !== null && level !== undefined && level >= 0;
    this._activity({
      gicon,
      title,
      sub: "",
      level: hasLevel ? Math.min(1, level / max) : null,
      color: "#ffffff",
      ms: 1600,
      mode: "osd",
    });
  }

  // banner block
  _hookNotifications() {
    const tray = Main.messageTray;
    this._srcSigs = new Map();
    try {
      this._origBlocked = tray.bannerBlocked;
      tray.bannerBlocked = true;
    } catch (_e) {}

    const hook = (src) => {
      if (this._srcSigs.has(src)) return;
      const id = src.connect("notification-added", (_s, n) =>
        this._onNotification(n),
      );
      this._srcSigs.set(src, id);
    };
    try {
      tray.getSources().forEach(hook);
    } catch (_e) {}
    this._trayId = tray.connect("source-added", (_t, src) => hook(src));
  }

  _unhookNotifications() {
    const tray = Main.messageTray;
    if (this._trayId) tray.disconnect(this._trayId);
    this._trayId = 0;
    for (const [src, id] of this._srcSigs ?? []) {
      try {
        src.disconnect(id);
      } catch (_e) {}
    }
    this._srcSigs?.clear();
    try {
      tray.bannerBlocked = this._origBlocked ?? false;
    } catch (_e) {}
  }

  _onNotification(n) {
    if (!this._notif.get_boolean("show-banners")) return;
    this._activity({
      gicon: n.gicon ?? n.source?.icon ?? null,
      icon: "preferences-system-notifications-symbolic",
      title: plain(n.title) || n.source?.title || "Notification",
      sub: plain(n.body).slice(0, 90),
      ms: 5000,
      action: () => {
        try {
          n.activate();
        } catch (_e) {}
        this._endActivity();
      },
    });
  }

  // power state
  _onPowerUpdate() {
    this._strips?.setBattery(this._power.percentage, this._power.state);
  }

  _onPower(kind, pct) {
    const d = {
      plugged: ["battery-full-charging-symbolic", "Charging", COLOR.power],
      unplugged: ["battery-full-symbolic", "On battery", "#ffffff"],
      full: ["battery-full-charged-symbolic", "Fully charged", COLOR.power],
      low: ["battery-caution-symbolic", "Battery low", COLOR.timer],
      critical: ["battery-empty-symbolic", "Battery critically low", COLOR.red],
    }[kind];
    if (!d) return;
    this._activity({
      icon: d[0],
      title: d[1],
      sub: `${pct}%`,
      level: pct / 100,
      color: d[2],
      ms: kind === "critical" || kind === "low" ? 5000 : 3000,
      force: kind === "critical",
    });
  }

  // media state
  _sameTrack(f, m) {
    return (
      (f.url && f.url === m.url) ||
      (!f.url && f.title === m.title && f.artist === m.artist)
    );
  }

  _toggleFavorite() {
    const m = this._media;
    if (!m || !m.title) return;
    const existing = this._favorites.items.find((f) => this._sameTrack(f, m));
    if (existing) {
      this._favorites.removeWhere((f) => f.id === existing.id);
    } else {
      this._favorites.add(
        {
          id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          title: m.title,
          artist: m.artist,
          url: m.url,
        },
        (a, b) => this._sameTrack(a, b),
      );
    }
    this._refreshCard();
  }

  // media updates
  _onMedia() {
    const cur = this._mpris.current;
    this._media = cur;
    const playing = cur?.status === "Playing";
    const key = cur ? `${cur.bus}|${cur.title}|${cur.artist}` : null;

    if (key !== this._posKey) {
      this._posKey = key;
      this._pos = 0;
      this._posKnown = false;
    }
    const lyrKey = cur ? `${key}|${Math.round((cur.length || 0) / 1e6)}` : null;
    if (lyrKey !== this._lyricsKey) {
      this._lyricsKey = lyrKey;
      this._lyrics = null;
      if (cur?.title) {
        this._lyricsFetcher.get(cur, (res) => {
          if (!this.actor || lyrKey !== this._lyricsKey) return;
          this._lyrics = res;
          this._fitCard();
          this._refreshCard();
        });
      }
      this._fitCard();
    }
    const artUrl = cur?.artUrl ?? "";
    if (artUrl !== this._artUrl) {
      this._artUrl = artUrl;
      this._artPath = null;
      this._artCache.resolve(artUrl, (path) => {
        if (artUrl !== this._artUrl || !this.actor) return;
        this._artPath = path;
        if (this._peekTrack && this._mode === "peek")
          setCover(this._pCover, path, 18);
        this._refreshCompact();
        this._refreshCard();
      });
    }

    if (playing && this._mediaSeen && key !== this._lastTrack && cur.title) {
      this._activity({
        track: true,
        coverPath: this._artPath,
        title: cur.title,
        sub: cur.artist,
        ms: 3200,
      });
    }
    if (playing) this._lastTrack = key;
    this._mediaSeen = true;

    this._refreshCompact();
    this._refreshCard();
    this._syncBase();
    this._updatePolling();
  }

  _animateBars() {
    for (const b of this._bars) {
      b.remove_all_transitions();
      b.ease({
        height: 4 + Math.floor(Math.random() * 12),
        duration: 300,
        mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
      });
    }
  }

  // timer clock
  _startTimer(sec) {
    this._timer.start(sec);
    this._afterTimerChange();
  }

  _toggleTimer() {
    if (this._timer.remaining <= 0) this._timer.start(25 * 60);
    else this._timer.toggle();
    this._afterTimerChange();
  }

  _resetTimer() {
    this._timer.reset();
    this._afterTimerChange();
  }

  _afterTimerChange() {
    this._refreshCard();
    this._refreshCompact();
    this._syncBase();
  }

  _onTimerTick() {
    if (this._mode === "card") this._card.tick();
    this._refreshCompact();
  }

  _onTimerDone() {
    try {
      global.display
        .get_sound_player()
        .play_from_theme("complete", "Timer finished", null);
    } catch (_e) {}
    const mins = Math.round(this._timer.total / 60);
    this._refreshCard();
    this._refreshCompact();
    this._activity({
      icon: "alarm-symbolic",
      title: "Timer finished",
      sub: `${mins} min`,
      color: COLOR.timer,
      ms: 8000,
      force: true,
    });
  }

  _tickClock() {
    this._strips?.tick();
    const now = GLib.DateTime.new_now_local();
    const h24 = this._iface.get_string("clock-format") === "24h";
    this._clockText = SHOW_CLOCK_IN_PILL
      ? h24
        ? now.format("%H:%M")
        : now.format("%-I:%M %p")
      : "";
    if (!this._showMusicTime) this._setPillText(this._clockText);
  }

  _setPillText(text) {
    if (text !== this._pillText) {
      this._pillText = text;
      this._cTime.set_text(text);
    }
  }

  _onSleepTick() {
    if (this._mode === "card") this._card.tick();
  }

  // sleep pause
  _onSleepDone() {
    this._mpris?.pauseAll();
    this._refreshCard();
    this._activity({
      icon: "weather-clear-night-symbolic",
      title: "Sleep timer",
      sub: "Music paused",
      ms: 5000,
      force: true,
    });
  }

  _addReminder(text, due) {
    this._reminders.add(text, due);
    this._refreshCard();
  }

  _onReminderDue(r) {
    try {
      global.display
        .get_sound_player()
        .play_from_theme("message-new-instant", "Reminder", null);
    } catch (_e) {}
    this._activity({
      icon: "alarm-symbolic",
      title: r.text,
      sub: "Reminder",
      color: COLOR.timer,
      ms: 9000,
      force: true,
      action: () => this._endActivity(),
    });
    this._refreshCard();
  }

  _toggleDnd() {
    this._notif.set_boolean(
      "show-banners",
      !this._notif.get_boolean("show-banners"),
    );
    this._strips?.setDnd(!this._notif.get_boolean("show-banners"));
  }

  _beginTyping() {
    if (this._typing) return;
    const grab = Main.pushModal(this.actor, {
      actionMode: Shell.ActionMode.POPUP,
    });
    if (!grab) return;
    this._grab = grab;
    this._typing = true;
    this._clear("hover");
    this._card.pages.reminders.entry.clutter_text.grab_key_focus();
  }

  _endTyping() {
    if (!this._typing) return;
    this._typing = false;
    try {
      Main.popModal(this._grab);
    } catch (_e) {}
    this._grab = null;
  }

  // compact state
  _refreshCompact() {
    const m = this._media;
    const playing = m?.status === "Playing";
    const timing = this._timer?.running;

    this._cArt.opacity = playing ? 255 : 0;
    if (this._artPath !== this._cArtPath) {
      this._cArtPath = this._artPath;
      setCover(this._cArt, this._artPath, 13);
    }

    this._showMusicTime = !!playing && this._posKnown;
    this._setPillText(
      this._showMusicTime ? fmtClock(this._pos / 1e6) : this._clockText,
    );

    const len = m?.length ?? 0;
    const showLine = this._showMusicTime && len > 0;
    this._pillTrack.visible = showLine;
    if (showLine) {
      const frac = Math.max(0, Math.min(1, this._pos / len));
      this._pillFill.set_width(
        Math.round(frac * (this._pillTrack.get_width() || 180)),
      );
    }

    this._cTimer.visible = !!timing;
    if (timing) {
      const t = this._timer.remaining;
      this._cTimer.set_text(
        `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`,
      );
    }
    const inPill = this._mode === "idle" || this._mode === "media";
    this._cBars.visible = !!playing && !timing;
    if (playing && inPill) {
      if (!this._timers.has("bars")) {
        this._every("bars", 380, () => this._animateBars());
        this._animateBars();
      }
    } else {
      this._clear("bars");
    }
  }
}
