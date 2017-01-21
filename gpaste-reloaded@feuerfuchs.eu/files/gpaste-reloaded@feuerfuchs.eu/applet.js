const uuid                  = imports.applet.uuid;

const Util                  = imports.misc.util;
const Lang                  = imports.lang;
const St                    = imports.gi.St;
const Main                  = imports.ui.main;
const PopupMenu             = imports.ui.popupMenu;
const Applet                = imports.ui.applet;
const Settings              = imports.ui.settings;
const ModalDialog           = imports.ui.modalDialog;
const SignalManager         = imports.misc.signalManager;

const GPaste                = imports.gi.GPaste;

const AppletDir             = imports.ui.appletManager.applets[uuid];
const GPasteSearchItem      = AppletDir.GPasteSearchItem;
const GPasteHistoryItem     = AppletDir.GPasteHistoryItem;
const GPasteHistoryListItem = AppletDir.GPasteHistoryListItem;
const GPasteNewItemDialog   = AppletDir.GPasteNewItemDialog;

const _                     = imports.applet._;

// ------------------------------------------------------------------------------------------------------

function GPasteApplet(orientation, panel_height, instance_id) {
    this._init(orientation, panel_height, instance_id);
}

GPasteApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(orientation, panel_height, instance_id) {
        Applet.IconApplet.prototype._init.call(this, orientation);

        try {
            //
            // Applet icon

            this.set_applet_icon_symbolic_name("edit-paste");
            this.set_applet_tooltip(_("GPaste clipboard"));
            Main.systrayManager.registerRole("gpaste-applet", uuid);

            //
            // Context menu items

            this.cmitemUI            = new PopupMenu.PopupIconMenuItem(_("GPaste Main Program"), "edit-paste", St.IconType.SYMBOLIC);
            this.cmitemUI.connect('activate', Lang.bind(this, this.openUI));

            this.cmsep               = new PopupMenu.PopupSeparatorMenuItem();

            this.cmitemSelectHistory = new PopupMenu.PopupSubMenuMenuItem(_("Select History"));

            //
            // Primary menu

            this.menuManager          = new PopupMenu.PopupMenuManager(this);
            this.menu                 = new Applet.AppletPopupMenu(this, orientation);
            this.menuManager.addMenu(this.menu);

            this.mitemTrack           = new PopupMenu.PopupSwitchMenuItem(_("Track clipboard changes"), true);
            this.mitemTrack.connect('toggled', Lang.bind(this, this.toggleDaemon));

            this.mitemSearch          = new GPasteSearchItem.GPasteSearchItem();
            this.mitemSearch.connect('text-changed', Lang.bind(this, function(a, text) { this.search(text); }));

            this.msepTop              = new PopupMenu.PopupSeparatorMenuItem();

            this.mitemHistoryIsEmpty  = new PopupMenu.PopupMenuItem(_("(Empty)"));
            this.mitemHistoryIsEmpty.setSensitive(false);

            this.mitemNoSearchResults = new PopupMenu.PopupMenuItem(_("(No results)"));
            this.mitemNoSearchResults.setSensitive(false);

            this.msepBottom           = new PopupMenu.PopupSeparatorMenuItem();

            this.mitemNewItem         = new PopupMenu.PopupIconMenuItem(_("New item"), "list-add", St.IconType.SYMBOLIC);
            this.mitemNewItem.connect('activate', Lang.bind(this, this.showNewItemDialog));

            this.mitemEmptyHistory    = new PopupMenu.PopupIconMenuItem(_("Empty history"), "edit-clear-all", St.IconType.SYMBOLIC);
            this.mitemEmptyHistory.connect('activate', Lang.bind(this, this.emptyHistory));

            this.msepBottom2          = new PopupMenu.PopupSeparatorMenuItem();

            this.mitemUI              = new PopupMenu.PopupIconMenuItem(_("GPaste Main Program"), "edit-paste", St.IconType.SYMBOLIC);
            this.mitemUI.connect('activate', Lang.bind(this, this.openUI));

            //
            // Dialogs

            this.dNewItem             = new GPasteNewItemDialog.GPasteNewItemDialog(Lang.bind(this, function(text) {
                this._client.add(text, Lang.bind(this, function(client, result) {
                    this._client.add_finish(result);
                }));
            }));

            //
            // Applet settings

            this._appletSettings = new Settings.AppletSettings(this, uuid, instance_id);

            this._appletSettings.bindProperty(Settings.BindingDirection.IN, "display-track-switch",  "displayTrackSwitch",  this._onDisplaySettingsUpdated, null);
            this._appletSettings.bindProperty(Settings.BindingDirection.IN, "display-new-item",      "displayNewItem",      this._onDisplaySettingsUpdated, null);
            this._appletSettings.bindProperty(Settings.BindingDirection.IN, "display-searchbar",     "displaySearchBar",    this._onDisplaySettingsUpdated, null);
            this._appletSettings.bindProperty(Settings.BindingDirection.IN, "display-gpaste-ui",     "displayGPasteUI",     this._onDisplaySettingsUpdated, null);
            this._appletSettings.bindProperty(Settings.BindingDirection.IN, "display-empty-history", "displayEmptyHistory", this._onDisplaySettingsUpdated, null);

            //
            // Create GPaste Client

            this._clientSettings   = new GPaste.Settings();
            this._searchResults    = [];
            this._historyName      = "";
            this._historyItems     = [];
            this._historyListItems = [];
            this._signalManager    = new SignalManager.SignalManager(this);

            GPaste.Client.new(Lang.bind(this, function (obj, result) {
                this._client = GPaste.Client.new_finish(result);

                //
                // Watch client signals

                // Client
                this._signalManager.connect(this._client, 'update',         this._onClientUpdate);
                this._signalManager.connect(this._client, 'show-history',   this._onClientShowHistory);
                this._signalManager.connect(this._client, 'switch-history', this._onClientSwitchHistory);
                this._signalManager.connect(this._client, 'tracking',       this._onClientTracking);
                this._signalManager.connect(this._client, 'delete-history', this._onClientDeleteHistory);

                // Client settings
                this._signalManager.connect(this._clientSettings, 'changed::max-displayed-history-size', this._createHistoryItems);

                //
                // Init

                // Get tracking status
                this.mitemTrack.setToggleState(this._client.is_active());

                // Get current history name
                this._client.get_history_name(Lang.bind(this, function(client, result) {
                    this._historyName = this._client.get_history_name_finish(result);

                    // Get history list
                    this._client.list_histories(Lang.bind(this, this._onClientHistoriesListed));

                    // Load history and populate applet
                    this._createHistoryItems();
                    this._populateMenus();
                }));
            }));

            //
            // Events

            this.menu.connect('open-state-changed', Lang.bind(this, function(menu, open) {
                if (open) {
                    if (this.displaySearchBar) {
                        global.stage.set_key_focus(this.mitemSearch.entry);
                    }
                } else {
                    this.mitemSearch.reset();
                }
            }));
        }
        catch (e) {
            global.logError(e);
        }
    },

    /*
     * Compares the current GPaste version with the given version string (only first 2 digits).
     * -1 = older, 0 = same, 1 = newer
     */
    _compareVersion: function(version) {
        version          = version.split(".");
        const curVersion = this._client.get_version().split(".");
        const maxLen     = Math.min(curVersion.length, version.length);

        for (let i = 0; i < maxLen; ++i) {
            const cv = parseInt(curVersion[i], 10);
            const v  = parseInt(version[i],    10);
            if (cv == v) {
                continue;
            }
            return ((cv < v) ? -1 : 1);
        }
        return 0;
    },

    /*
     * Applet settings were changed
     */
    _onDisplaySettingsUpdated: function() {
        this.mitemSearch.reset();

        this.mitemTrack.actor.visible        = this.displayTrackSwitch;
        this.msepTop.actor.visible           = this.displayTrackSwitch;
        this.mitemSearch.actor.visible       = this.displaySearchBar;

        this.msepBottom.actor.visible        = this.displayNewItem || this.displayGPasteUI || this.displayEmptyHistory;
        this.mitemNewItem.actor.visible      = this.displayNewItem;
        this.mitemEmptyHistory.actor.visible = this.displayEmptyHistory;

        this.msepBottom2.actor.visible       = this.displayGPasteUI;
        this.mitemUI.actor.visible           = this.displayGPasteUI;
    },

    /*
     * Generate the required number of history items (or delete excessive ones)
     */
    _createHistoryItems: function() {
        const oldSize = this._historyItems.length;
        const newSize = this._clientSettings.get_max_displayed_history_size();

        if (newSize > oldSize) {
            for (let i = oldSize; i < newSize; ++i) {
                this._historyItems[i] = new GPasteHistoryItem.GPasteHistoryItem(this);
            }
        } else {
            for (let i = newSize; i < oldSize; ++i) {
                this._historyItems.pop().destroy();
            }
        }

        if (this.mitemSearch.entry.get_text() == '') {
            this._historyItems[0].actor.set_style("font-weight: bold;");
        }

        this.refresh(oldSize);
    },

    /*
     * Add all necessary menu items to the menus
     */
    _populateMenus: function() {
        //
        // Context menu

        let i = -1;
        if (this._compareVersion("3.18") != -1) {
            this._applet_context_menu.addMenuItem(this.cmitemUI, ++i);
            this._applet_context_menu.addMenuItem(this.cmsep, ++i);
        }
        this._applet_context_menu.addMenuItem(this.cmitemSelectHistory, ++i);
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(), ++i);

        //
        // Primary menu

        this.menu.addMenuItem(this.mitemTrack);
        this.menu.addMenuItem(this.mitemSearch);

        this.menu.addMenuItem(this.msepTop);

        for (let i = 0, len = this._historyItems.length; i < len; ++i) {
            this.menu.addMenuItem(this._historyItems[i]);
        }
        this.menu.addMenuItem(this.mitemHistoryIsEmpty);
        this.menu.addMenuItem(this.mitemNoSearchResults);

        this.menu.addMenuItem(this.msepBottom);

        this.menu.addMenuItem(this.mitemNewItem);
        this.menu.addMenuItem(this.mitemEmptyHistory);

        if (this._compareVersion("3.18.2") != -1) {
            this.menu.addMenuItem(this.msepBottom2);
            this.menu.addMenuItem(this.mitemUI);
        }

        //
        // Hide disabled menu items

        this._onDisplaySettingsUpdated();
    },

    /*
     * Getters
     */
    get client() {
        return this._client;
    },

    get clientSettings() {
       return this._clientSettings;
    },

    get contextMenu() {
        return this._applet_context_menu;
    },

    /*
     * Refresh the history items
     */
    refresh: function(startID) {
        if (this._searchResults.length > 0) { // Search field isn't empty
            this.search(this.mitemSearch.getText());
        } else {
            this._client.get_history_size(this._historyName, Lang.bind(this, function(client, result) {
                let   size    = client.get_history_size_finish(result);
                const maxSize = this._historyItems.length;

                if (size > maxSize) {
                    size = maxSize;
                }

                for (let i = startID; i < size; ++i) {
                    this._historyItems[i].setIndex(i);
                }
                for (let i = size; i < maxSize; ++i) {
                    this._historyItems[i].setIndex(-1);
                }

                if (size == 0) { // There aren't any history items, display "(Empty)"
                    this.mitemHistoryIsEmpty.actor.show();
                } else {
                    this.mitemHistoryIsEmpty.actor.hide();
                }
            }));
        }
    },

    /*
     * Search the history for the given string
     */
    search: function(searchStr) {
        searchStr = searchStr.toLowerCase();

        if (searchStr.length > 0) {
            this.mitemHistoryIsEmpty.actor.hide();

            this._client.search(searchStr, Lang.bind(this, function(client, result) {
                this._searchResults = client.search_finish(result);
                let   results = this._searchResults.length;
                const maxSize = this._historyItems.length;

                if (results > maxSize) {
                    results = maxSize;
                }

                this._historyItems.slice(0, results).forEach(Lang.bind(this, function(item, index) {
                    item.setIndex(this._searchResults[index]);
                }));
                this._historyItems.slice(results, maxSize).forEach(Lang.bind(this, function(item, index) {
                    item.setIndex(-1);
                }));

                this._historyItems[0].actor.set_style(null);

                if (results == 0) { // There aren't any results, display "(No results)"
                    this.mitemNoSearchResults.actor.show();
                } else {
                    this.mitemNoSearchResults.actor.hide();
                }
            }));
        } else {
            this.mitemNoSearchResults.actor.hide();

            this._searchResults = [];
            this.refresh(0);
            this._historyItems[0].actor.set_style("font-weight: bold;");
        }
    },

    /*
     * Toggle GPaste's tracking status
     */
    toggleDaemon: function() {
        this._client.track(this.mitemTrack.state, null);
    },

    /*
     * Select another history
     */
    selectHistory: function(name) {
        this._client.switch_history(name, Lang.bind(this, function(client, result) {
            this._client.switch_history_finish(result);
        }));
    },

    /*
     * Empty the history
     */
    emptyHistory: function() {
        new ModalDialog.ConfirmDialog(_("Do you really want to empty the current history?"), Lang.bind(this, function() {
            this._client.empty_history(this._historyName, null);
        })).open(global.get_current_time());
    },

    /*
     * Open GPaste's own GUI
     */
    openUI: function() {
        try {
            GPaste.util_spawn('Ui');
        }
        catch (e) { // Native approach didn't work, try alternative
            Util.spawnCommandLine("gpaste-client ui");
        }
    },

    /*
     *
     */
    showNewItemDialog: function() {
        this.dNewItem.open(global.get_current_time());
    },

    //
    // Events
    // ---------------------------------------------------------------------------------

    /*
     * The history has changed
     */
    _onClientUpdate: function(client, action, target, position) {
        global.log("[" + uuid + "] Client event: _onClientUpdate");

        switch (target) {
            case GPaste.UpdateTarget.ALL:
                this.refresh(0);
                break;

            case GPaste.UpdateTarget.POSITION:
                switch (action) {
                    case GPaste.UpdateAction.REPLACE:
                        this._historyItems[position].refresh();
                        break;
                    case GPaste.UpdateAction.REMOVE:
                        this.refresh(position);
                        break;
                }
                break;
        }
    },

    /*
     * GPaste returned the list of histories
     */
    _onClientHistoriesListed: function(client, result) {
        global.log("[" + uuid + "] Client event: _onClientHistoriesListed");

        const histories = this._client.list_histories_finish(result);

        for (let n in this._historyListItems) {
            this._historyListItems[n].destroy();
            delete this._historyListItems[n];
        }

        histories.forEach(Lang.bind(this, function(name, index) {
            if (name == "") return;

            const item = new GPasteHistoryListItem.GPasteHistoryListItem(this, name);

            if (name == this._historyName) {
                item.setShowDot(true);
            }

            this.cmitemSelectHistory.menu.addMenuItem(item);
            this._historyListItems[name] = item;
        }));
    },

    /*
     * A history was deleted
     */
    _onClientDeleteHistory: function(client, name) {
        global.log("[" + uuid + "] Client event: _onClientDeleteHistory");

        for (let n in this._historyListItems) {
            if (n == name) {
                this._historyListItems[n].destroy();
                delete this._historyListItems[n];
            }
        }
    },

    /*
     * Show menu
     */
    _onClientShowHistory: function() {
        global.log("[" + uuid + "] Client event: _onClientShowHistory");

        this.menu.open();
    },

    /*
     *
     */
    _onClientSwitchHistory: function() {
        global.log("[" + uuid + "] Client event: _onClientSwitchHistory");

        this._client.list_histories(Lang.bind(this, this._onClientHistoriesListed));

        this._client.get_history_name(Lang.bind(this, function(client, result) {
            this._historyName = this._client.get_history_name_finish(result);

            this.refresh();

            for (let n in this._historyListItems) {
                const item = this._historyListItems[n];
                item.setShowDot(item.histName == this._historyName);
            }
        }));
    },

    /*
     * GPaste's tracking status has changed
     */
    _onClientTracking: function(client, state) {
        global.log("[" + uuid + "] Client event: _onClientTracking");

        this.mitemTrack.setToggleState(state);
    },

    //
    // Overrides
    // ---------------------------------------------------------------------------------

    /*
     * Applet has been removed, disconnect signal handlers
     */
    on_applet_removed_from_panel: function() {
        global.log("GPaste applet was removed from panel");

        this._signalManager.disconnectAllSignals();
    },

    /*
     * Applet has been clicked, display menu
     */
    on_applet_clicked: function(event) {
        this.menu.toggle();
    }
};

// ------------------------------------------------------------------------------------------------------

/*
 * Entry point
 */
function main(metadata, orientation, panel_height, instance_id) {
    return new GPasteApplet(orientation, panel_height, instance_id);
};