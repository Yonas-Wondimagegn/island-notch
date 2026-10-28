import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Island} from './island.js';

export default class IslandExtension extends Extension {
    enable() {
        this._island = new Island();
        this._island.enable();
    }

    disable() {
        this._island?.destroy();
        this._island = null;
    }
}
