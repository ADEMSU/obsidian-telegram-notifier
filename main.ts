import { App, Plugin, PluginSettingTab, Setting, TFile, moment, Notice, MarkdownView, Editor, Menu } from 'obsidian';

// --- Interfaces ---

interface ReminderPreset {
    name: string;
    offsets: string[];       
    message_template?: string; 
}

interface PluginSettings {
    // Connection
    botToken: string;
    chatId: string;
    
    // Time & Scope
    checkIntervalMinutes: number;
    timezoneOffset: number; // e.g. 3 for UTC+3
    startHour: number; // 9
    endHour: number;   // 21
    
    // Templates
    defaultReviewTemplate: string;
    defaultInlineTemplate: string;
    
    // Data config (separated)
    allowedFieldsSingle: string; // for review_date
    allowedFieldsPreset: string; // for recurring presets
    
    presets: ReminderPreset[];
    sentHistory: Record<string, number>; 
}

const DEFAULT_SETTINGS: PluginSettings = {
    botToken: '',
    chatId: '',
    
    checkIntervalMinutes: 60, // Default 1 hour as requested
    timezoneOffset: 0, // UTC default
    startHour: 9,
    endHour: 21,
    
    defaultReviewTemplate: "📅 Reminder: {filename}\nPlease review this note.",
    defaultInlineTemplate: "✅ Task: {task}\nFrom note: {filename}",
    
    allowedFieldsSingle: "priority, type",
    allowedFieldsPreset: "payment_sum, client, project_link",

    presets: [
        { 
            name: "finance", 
            offsets: ["-7d", "0m"],
            message_template: "💸 Pay: {filename}\nAmount: {payment_sum}"
        }
    ],
    sentHistory: {}
};

// --- Main Plugin Class ---

export default class TelegramNotifierPlugin extends Plugin {
    settings: PluginSettings;
    intervalId: number | null = null;
    statusBarItem: HTMLElement | null = null;

    async onload() {
        await this.loadSettings();
        
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar("Ready");

        this.addSettingTab(new TelegramNotifierSettingTab(this.app, this));
        this.startLoop();

        this.addCommand({
            id: 'check-reminders-now',
            name: 'Force check reminders now',
            callback: () => {
                this.checkReminders();
                new Notice('Scanning for reminders...');
            }
        });

        // --- Context Menu ---
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
                menu.addSeparator();

                // 1. Single Reminder
                menu.addItem((item) => {
                    item.setTitle('🔔 TG: Insert Single Reminder')
                        .setIcon('calendar')
                        .onClick(() => {
                            const fields = this.generateYamlFields(this.settings.allowedFieldsSingle);
                            const snippet = `---\nreview_date: ${this.getCurrentTime()}\n${fields}---\n`;
                            editor.replaceSelection(snippet);
                        });
                });

                // 2. Inline Task
                menu.addItem((item) => {
                    item.setTitle('✅ TG: Insert Inline Task')
                        .setIcon('check-square')
                        .onClick(() => {
                            const snippet = `- [ ] New Task [check:: ${this.getCurrentTime()}]`;
                            editor.replaceSelection(snippet);
                        });
                });

                // 3. Presets
                this.settings.presets.forEach(preset => {
                    menu.addItem((item) => {
                        item.setTitle(`🔄 TG: Insert Preset '${preset.name}'`)
                            .setIcon('refresh-cw')
                            .onClick(() => {
                                const fields = this.generateYamlFields(this.settings.allowedFieldsPreset);
                                const snippet = `---\ndue_date: ${moment().add(this.settings.timezoneOffset, 'hours').format("YYYY-MM-DD")}\nreminder_preset: ${preset.name}\n${fields}---\n`;
                                editor.replaceSelection(snippet);
                            });
                    });
                });
            })
        );
    }

    onunload() {
        if (this.intervalId) window.clearInterval(this.intervalId);
    }

    startLoop() {
        if (this.intervalId) window.clearInterval(this.intervalId);
        const ms = this.settings.checkIntervalMinutes * 60 * 1000;
        this.intervalId = window.setInterval(() => this.checkReminders(), ms);
    }

    updateStatusBar(text: string) {
        if (this.statusBarItem) this.statusBarItem.setText(`🤖 TG: ${text}`);
    }

    getCurrentTime(): string {
        return moment().add(this.settings.timezoneOffset, 'hours').format("YYYY-MM-DD HH:mm");
    }

    // Generate empty YAML fields from config string
    generateYamlFields(configStr: string): string {
        if (!configStr.trim()) return "";
        return configStr.split(',').map(s => `${s.trim()}: `).join('\n') + '\n';
    }

    async checkReminders() {
        // 1. Check Working Hours
        const now = moment().add(this.settings.timezoneOffset, 'hours');
        const currentHour = now.hour();
        
        if (currentHour < this.settings.startHour || currentHour >= this.settings.endHour) {
            this.updateStatusBar(`Sleep (Zzz... ${currentHour}:00)`);
            return; // Silent mode at night
        }

        this.updateStatusBar("Scanning...");
        const files = this.app.vault.getMarkdownFiles();

        // 2. Scan Files
        for (const file of files) {
            await this.processFile(file, now);
        }
        
        // 3. Cleanup History (Optional: remove keys for files that no longer exist or valid? 
        // For simplicity and performance, we keep history but we WON'T fire if date is removed).
        
        await this.saveSettings();
        this.updateStatusBar(`Last scan ${now.format("HH:mm")}`);
    }

    async processFile(file: TFile, now: moment.Moment) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return;

        // --- Logic: Frontmatter ---
        if (cache.frontmatter) {
            const fm = cache.frontmatter;

            // A. Single Review
            if (fm.review_date) {
                const targetTime = this.parseDate(fm.review_date);
                if (targetTime && targetTime.isValid()) {
                    // Logic: If targetTime exists, we check it.
                    const msg = this.formatTemplate(this.settings.defaultReviewTemplate, file, fm, "", this.settings.allowedFieldsSingle);
                    await this.tryNotify(file, "review", targetTime, now, msg);
                }
            } else {
                // If review_date removed -> we consider it "done" or "cancelled". 
                // We do NOT clear history explicitly here to avoid spam if user types date back.
                // But since we rely on `fm.review_date` existence, notification won't fire.
            }

            // B. Presets
            if (fm.due_date && fm.reminder_preset) {
                const baseTime = this.parseDate(fm.due_date);
                const preset = this.settings.presets.find(p => p.name === fm.reminder_preset);
                
                if (baseTime && baseTime.isValid() && preset) {
                    for (const offset of preset.offsets) {
                        const triggerTime = this.applyOffset(baseTime.clone(), offset);
                        let tpl = preset.message_template || "🔔 Reminder: {filename}";
                        const msg = this.formatTemplate(tpl, file, fm, offset, this.settings.allowedFieldsPreset);
                        await this.tryNotify(file, `preset_${fm.reminder_preset}_${offset}`, triggerTime, now, msg);
                    }
                }
            }
        }

        // --- Logic: Inline ---
        // We must read file content to check checkboxes state
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        // Regex searches for UNCHECKED box "- [ ]" only. 
        // If user checks it "- [x]", regex won't match -> notification logic won't run.
        const inlineRegex = /- \[ \] .*\[check::\s*(.*?)\]/i;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(inlineRegex);
            if (match) {
                const dateStr = match[1].trim();
                const targetTime = this.parseDate(dateStr);
                if (targetTime && targetTime.isValid()) {
                    const taskText = line.replace(/\[check::.*?\]/, '').replace('- [ ]', '').trim();
                    const msg = this.formatTemplate(this.settings.defaultInlineTemplate, file, { task: taskText }, "", "task");
                    await this.tryNotify(file, `inline_line_${i}`, targetTime, now, msg);
                }
            }
            // If line doesn't match (checkbox checked or tag removed), we do nothing.
        }
    }

    async tryNotify(file: TFile, uniqueContext: string, triggerTime: moment.Moment, now: moment.Moment, message: string) {
        const id = `${file.path}::${uniqueContext}::${triggerTime.valueOf()}`;
        
        // Anti-spam check: already sent?
        if (this.settings.sentHistory[id]) return;

        // Time check
        if (triggerTime.isSameOrBefore(now)) {
            const success = await this.sendTelegram(message);
            if (success) {
                this.settings.sentHistory[id] = now.valueOf();
            }
        }
    }

    async sendTelegram(text: string): Promise<boolean> {
        if (!this.settings.botToken || !this.settings.chatId) return false;
        const url = `https://api.telegram.org/bot${this.settings.botToken}/sendMessage`;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: this.settings.chatId, text: text, parse_mode: 'Markdown' })
            });
            return res.ok;
        } catch (error) {
            console.error("Telegram error:", error);
            this.updateStatusBar("Error!");
            return false;
        }
    }

    parseDate(input: string): moment.Moment | null {
        // Parse assuming input is in "User Time", convert strictly
        return moment(input, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
    }

    applyOffset(date: moment.Moment, offset: string): moment.Moment {
        const regex = /([+-]?\d+)([wdhm])/;
        const match = offset.match(regex);
        if (!match) return date;
        return date.add(parseInt(match[1]), match[2] as moment.unitOfTime.DurationConstructor);
    }

    formatTemplate(template: string, file: TFile, data: any, offset: string = "", allowedStr: string): string {
        let text = template;
        text = text.replace(/{filename}/g, file.basename);
        text = text.replace(/{offset}/g, offset);
        
        const allowed = allowedStr.split(',').map(s => s.trim());
        allowed.push('task'); // always allow task text

        const matches = text.match(/{.*?}/g);
        if (matches) {
            matches.forEach(token => {
                const key = token.replace(/[{}]/g, '');
                // Check allow list and existence
                if (allowed.includes(key) && data && data[key] !== undefined) {
                    text = text.replace(token, String(data[key]));
                }
            });
        }
        return text;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// --- Settings Tab ---

class TelegramNotifierSettingTab extends PluginSettingTab {
    plugin: TelegramNotifierPlugin;
    genType: string = 'single';
    genPreset: string = '';
    jsonError: string = '';

    constructor(app: App, plugin: TelegramNotifierPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Telegram Notifier Setup' });

        // --- Connection ---
        const connDiv = containerEl.createDiv();
        connDiv.style.border = '1px solid var(--background-modifier-border)';
        connDiv.style.padding = '10px'; connDiv.style.marginBottom = '20px';
        
        new Setting(connDiv).setName('Bot Token').addText(t => t.setValue(this.plugin.settings.botToken).onChange(async v => { this.plugin.settings.botToken = v; await this.plugin.saveSettings(); }));
        new Setting(connDiv).setName('Chat ID').addText(t => t.setValue(this.plugin.settings.chatId).onChange(async v => { this.plugin.settings.chatId = v; await this.plugin.saveSettings(); }));
        new Setting(connDiv).setName('Test Connection').addButton(b => b.setButtonText('Send Test Message 🚀').onClick(async () => { 
            if(!this.plugin.settings.botToken) return;
            await this.plugin.sendTelegram("Ping! Connection OK."); new Notice('Sent!');
        }));

        // --- Time Settings ---
        containerEl.createEl('h3', { text: '🕒 Time & Schedule' });
        containerEl.createEl('p', { text: 'Notifications will only be sent within this range. If date is removed from note, notifications stop.' });
        
        new Setting(containerEl).setName('Check Interval (min)').addSlider(s => s.setLimits(1,60,1).setValue(this.plugin.settings.checkIntervalMinutes).setDynamicTooltip().onChange(async v => { this.plugin.settings.checkIntervalMinutes = v; await this.plugin.saveSettings(); this.plugin.startLoop(); }));
        new Setting(containerEl).setName('Timezone Offset (Hours)').setDesc('Your UTC offset').addText(t => t.setValue(String(this.plugin.settings.timezoneOffset)).onChange(async v => { this.plugin.settings.timezoneOffset = Number(v); await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Working Hours').setDesc('Start Hour (0-23) — End Hour (0-23)').addText(t => t.setPlaceholder('Start').setValue(String(this.plugin.settings.startHour)).onChange(async v => { this.plugin.settings.startHour = Number(v); await this.plugin.saveSettings(); }))
            .addText(t => t.setPlaceholder('End').setValue(String(this.plugin.settings.endHour)).onChange(async v => { this.plugin.settings.endHour = Number(v); await this.plugin.saveSettings(); }));

        // --- Configuration ---
        containerEl.createEl('h3', { text: '⚙️ Fields & Templates' });
        
        new Setting(containerEl).setName('Allowed Fields (Single)').setDesc('YAML fields for Single Reminders (comma separated). Will be auto-inserted.').addTextArea(t => { t.setValue(this.plugin.settings.allowedFieldsSingle).onChange(async v => { this.plugin.settings.allowedFieldsSingle = v; await this.plugin.saveSettings(); }); t.inputEl.style.width = '100%'; });
        new Setting(containerEl).setName('Allowed Fields (Preset)').setDesc('YAML fields for Recurring Presets.').addTextArea(t => { t.setValue(this.plugin.settings.allowedFieldsPreset).onChange(async v => { this.plugin.settings.allowedFieldsPreset = v; await this.plugin.saveSettings(); }); t.inputEl.style.width = '100%'; });

        new Setting(containerEl).setName('Standard Review Template').addTextArea(t => { t.setValue(this.plugin.settings.defaultReviewTemplate).onChange(async v => { this.plugin.settings.defaultReviewTemplate = v; await this.plugin.saveSettings(); }); t.inputEl.style.width = '100%'; });
        new Setting(containerEl).setName('Inline Task Template').addTextArea(t => { t.setValue(this.plugin.settings.defaultInlineTemplate).onChange(async v => { this.plugin.settings.defaultInlineTemplate = v; await this.plugin.saveSettings(); }); t.inputEl.style.width = '100%'; });

        // --- Presets ---
        containerEl.createEl('h3', { text: 'Presets (JSON)' });
        if (this.jsonError) containerEl.createEl('div', { text: '❌ ' + this.jsonError, cls: 'error-msg' });
        new Setting(containerEl).setClass('json-config-area').addTextArea(t => {
            t.setValue(JSON.stringify(this.plugin.settings.presets, null, 2)).onChange(async v => {
                try { this.plugin.settings.presets = JSON.parse(v); this.jsonError = ''; await this.plugin.saveSettings(); t.inputEl.style.border = "1px solid green"; setTimeout(() => this.display(), 500); }
                catch (e: any) { this.jsonError = e.message; t.inputEl.style.border = "1px solid red"; }
            });
            t.inputEl.style.width = "100%"; t.inputEl.style.height = "150px"; t.inputEl.style.fontFamily = "monospace";
        });

        // --- Generator ---
        containerEl.createEl('hr');
        const genDiv = containerEl.createDiv(); genDiv.style.padding = '15px'; genDiv.style.backgroundColor = 'var(--background-secondary)';
        genDiv.createEl('h3', { text: '🛠️ Snippet Generator' });

        new Setting(genDiv).setName('Type').addDropdown(dd => {
            dd.addOption('single', 'Single Reminder');
            dd.addOption('recurring', 'Recurring (Preset)');
            dd.addOption('inline', 'Inline Task');
            dd.setValue(this.genType); dd.onChange(async v => { this.genType = v; this.display(); });
        });

        if (this.genType === 'recurring') {
            new Setting(genDiv).setName('Select Preset').addDropdown(dd => {
                this.plugin.settings.presets.forEach(p => dd.addOption(p.name, p.name));
                if (!this.genPreset && this.plugin.settings.presets.length > 0) this.genPreset = this.plugin.settings.presets[0].name;
                dd.setValue(this.genPreset); dd.onChange(v => { this.genPreset = v; this.display(); });
            });
        }

        // Generate dynamic snippet
        const time = moment().add(this.plugin.settings.timezoneOffset, 'hours');
        let snippet = "";
        
        if (this.genType === 'single') {
            const fields = this.plugin.generateYamlFields(this.plugin.settings.allowedFieldsSingle);
            snippet = `---\nreview_date: ${time.format("YYYY-MM-DD HH:mm")}\n${fields}---`;
        } else if (this.genType === 'recurring') {
            const fields = this.plugin.generateYamlFields(this.plugin.settings.allowedFieldsPreset);
            snippet = `---\ndue_date: ${time.format("YYYY-MM-DD")}\nreminder_preset: ${this.genPreset || 'finance'}\n${fields}---`;
        } else if (this.genType === 'inline') {
            snippet = `- [ ] Task [check:: ${time.format("YYYY-MM-DD HH:mm")}]`;
        }

        const outArea = genDiv.createEl('textarea');
        outArea.value = snippet;
        outArea.style.width = '100%'; outArea.style.height = '100px'; outArea.style.fontFamily = 'monospace';

        const btnRow = genDiv.createDiv(); btnRow.style.marginTop = '10px'; btnRow.style.display = 'flex'; btnRow.style.gap = '10px';
        
        const copyBtn = btnRow.createEl('button', { text: 'Copy 📋' });
        copyBtn.onclick = () => { navigator.clipboard.writeText(snippet); new Notice('Copied!'); };

        const insertBtn = btnRow.createEl('button', { text: 'Insert to Open Note 📝', cls: 'mod-cta' });
        insertBtn.onclick = () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) { view.editor.replaceSelection(snippet + "\n"); new Notice('Inserted!'); } else { new Notice('No active note.'); }
        };
    }
}
