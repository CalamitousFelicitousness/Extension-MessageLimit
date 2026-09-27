import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../../utils.js';

export default 'MessageLimit'; // Init ES module

const context = SillyTavern.getContext();
const settingsKey = 'messageLimit';

/**
 * @type {MessageLimitSettings}
 * @typedef {Object} MessageLimitSettings
 * @property {boolean} enabled - Whether the extension is enabled.
 * @property {boolean} quietPrompts - Whether to apply the message limit to quiet prompts.
 * @property {number} limit - Maximum number of messages to send (-1 = unlimited).
 * @property {number} imageLimit - Maximum number of most-recent images to keep (-1 = unlimited).
 * @property {number} videoLimit - Maximum number of most-recent videos to keep (-1 = unlimited).
 * @property {number} imageDepth - Only keep images from the last N messages (-1 = unlimited).
 * @property {number} videoDepth - Only keep videos from the last N messages (-1 = unlimited).
 * @property {boolean} noteDroppedMedia - Whether to note pruned media in the message text.
 */
const defaultSettings = Object.freeze({
    enabled: false,
    quietPrompts: false,
    limit: 10,
    imageLimit: -1,
    videoLimit: -1,
    imageDepth: -1,
    videoDepth: -1,
    noteDroppedMedia: false,
});

/**
 * Describes the setting that pruned media of one type.
 * @param {string} type Media type
 * @param {'depth' | 'count'} rule Pruning rule
 * @param {number} n Setting value
 * @returns {string} Clause stating what the setting sends
 */
function describeRule(type, rule, n) {
    if (n === 0) return `no ${type}s are sent`;
    if (rule === 'depth') {
        return n === 1 ? `only ${type}s on the latest message are sent` : `only ${type}s on the last ${n} messages are sent`;
    }
    return n === 1 ? `only the newest ${type} is sent` : `only the ${n} newest ${type}s are sent`;
}

/**
 * Returns the message text with a note about media pruned from this request.
 * The result is sent to the model only; the stored chat message is unchanged.
 * @param {string} mes Message text as it will be sent
 * @param {{ type: string, rule: 'depth' | 'count' }[]} dropped Media pruned from this message
 * @param {Record<string, { depth: number, count: number }>} limits Media settings by type
 * @returns {string} Message text to send
 */
function annotateDroppedMedia(mes, dropped, limits) {
    // Depth is the same for every item on a message, so one rule prunes each type.
    const byType = new Map();
    for (const { type, rule } of dropped) {
        const entry = byType.get(type) ?? { n: 0, rule };
        entry.n++;
        byType.set(type, entry);
    }
    const counts = [];
    const reasons = [];
    for (const [type, { n, rule }] of byType) {
        counts.push(`${n} ${type}${n === 1 ? '' : 's'}`);
        reasons.push(describeRule(type, rule, limits[type][rule]));
    }
    const single = dropped.length === 1;
    const note = `[Message Limit extension: ${counts.join(' and ')} on this message ${single ? 'is' : 'are'} not included in this request, because ${reasons.join(' and ')}. Earlier requests may have included the actual ${single ? 'file' : 'files'}.]`;
    return mes ? `${mes}\n\n${note}` : note;
}

/**
 * Intercepts message generation to limit the number of messages.
 * @param {object[]} chat Chat messages
 * @param {number} _contextSize Context size (not used)
 * @param {function} _abort Abort function (not used)
 * @param {string} type Generation type
 */
globalThis.MessageLimit_interceptGeneration = function (chat, _contextSize, _abort, type) {
    /** @type {MessageLimitSettings} */
    const settings = context.extensionSettings[settingsKey];
    if (!settings.enabled) {
        return;
    }
    if (type === 'quiet' && !settings.quietPrompts) {
        return;
    }
    if (Number.isFinite(settings.limit) && settings.limit >= 0) {
        while (chat.length > settings.limit) {
            chat.shift();
        }
    }

    const imageLimit = Number(settings.imageLimit);
    const videoLimit = Number(settings.videoLimit);
    const imageDepth = Number(settings.imageDepth);
    const videoDepth = Number(settings.videoDepth);
    const pruneImages = Number.isFinite(imageLimit) && imageLimit >= 0;
    const pruneVideos = Number.isFinite(videoLimit) && videoLimit >= 0;
    const pruneImageDepth = Number.isFinite(imageDepth) && imageDepth >= 0;
    const pruneVideoDepth = Number.isFinite(videoDepth) && videoDepth >= 0;
    if (!pruneImages && !pruneVideos && !pruneImageDepth && !pruneVideoDepth) {
        return;
    }

    let imagesKept = 0;
    let videosKept = 0;

    // Returns the rule ('depth' or 'count') that drops this media item from
    // the request, or null to keep it. Depth cutoffs are applied first
    // (positional: relative to the end of the retained chat), then the
    // per-type count cutoffs. Only items that survive both checks bump the
    // counter, so limits reflect what is actually being sent rather than
    // what is stored on the messages.
    const getDropRule = (item, msgIdx) => {
        if (!item) return null;
        const depth = chat.length - 1 - msgIdx;
        if (item.type === 'image') {
            if (pruneImageDepth && depth >= imageDepth) return 'depth';
            if (pruneImages) {
                if (imagesKept >= imageLimit) return 'count';
                imagesKept++;
            }
            return null;
        }
        if (item.type === 'video') {
            if (pruneVideoDepth && depth >= videoDepth) return 'depth';
            if (pruneVideos) {
                if (videosKept >= videoLimit) return 'count';
                videosKept++;
            }
            return null;
        }
        return null;
    };

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        const media = message?.extra?.media;
        if (!Array.isArray(media) || media.length === 0) {
            continue;
        }

        const mediaDisplay = message.extra.media_display || 'list';
        const dropped = [];
        let extra = message.extra;

        if (mediaDisplay === 'gallery') {
            const idx = Number.isInteger(message.extra.media_index) ? message.extra.media_index : 0;
            const selected = media[idx];
            const rule = getDropRule(selected, i);
            if (rule) {
                // Gallery mode sends only the indexed item, so dropping it
                // means the message contributes no media at all.
                dropped.push({ type: selected.type, rule });
                extra = { ...extra, media: [], media_index: 0 };
            }
        } else {
            const filteredMedia = [];
            for (const item of media) {
                const rule = getDropRule(item, i);
                if (rule) {
                    dropped.push({ type: item.type, rule });
                } else {
                    filteredMedia.push(item);
                }
            }
            if (dropped.length > 0) {
                extra = { ...extra, media: filteredMedia };
            }
        }

        if (dropped.length === 0) {
            continue;
        }

        const mes = settings.noteDroppedMedia
            ? annotateDroppedMedia(message.mes, dropped, {
                image: { depth: imageDepth, count: imageLimit },
                video: { depth: videoDepth, count: videoLimit },
            })
            : message.mes;
        chat[i] = { ...message, mes, extra };
    }
};

function addSettings() {
    /** @type {MessageLimitSettings} */
    const settings = context.extensionSettings[settingsKey];

    const settingsContainer = document.getElementById('message_limit_container') ?? document.getElementById('extensions_settings');
    if (!settingsContainer) {
        return;
    }

    const inlineDrawer = document.createElement('div');
    inlineDrawer.classList.add('inline-drawer');
    settingsContainer.append(inlineDrawer);

    const inlineDrawerToggle = document.createElement('div');
    inlineDrawerToggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');

    const extensionName = document.createElement('b');
    extensionName.textContent = context.t`Message Limit`;

    const inlineDrawerIcon = document.createElement('div');
    inlineDrawerIcon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');

    inlineDrawerToggle.append(extensionName, inlineDrawerIcon);

    const inlineDrawerContent = document.createElement('div');
    inlineDrawerContent.classList.add('inline-drawer-content');

    inlineDrawer.append(inlineDrawerToggle, inlineDrawerContent);

    // Enabled
    const enabledCheckboxLabel = document.createElement('label');
    enabledCheckboxLabel.classList.add('checkbox_label', 'marginBot5');
    enabledCheckboxLabel.htmlFor = 'messageLimitEnabled';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.id = 'messageLimitEnabled';
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = settings.enabled;
    enabledCheckbox.addEventListener('change', () => {
        settings.enabled = enabledCheckbox.checked;
        context.saveSettingsDebounced();
    });
    const enabledCheckboxText = document.createElement('span');
    enabledCheckboxText.textContent = context.t`Enabled`;
    enabledCheckboxLabel.append(enabledCheckbox, enabledCheckboxText);
    inlineDrawerContent.append(enabledCheckboxLabel);

    // Apply to quiet prompts
    const quietPromptsCheckboxLabel = document.createElement('label');
    quietPromptsCheckboxLabel.classList.add('checkbox_label', 'marginBot5');
    quietPromptsCheckboxLabel.htmlFor = 'messageLimitQuietPrompts';
    const quietPromptsCheckbox = document.createElement('input');
    quietPromptsCheckbox.id = 'messageLimitQuietPrompts';
    quietPromptsCheckbox.type = 'checkbox';
    quietPromptsCheckbox.checked = settings.quietPrompts;
    quietPromptsCheckbox.addEventListener('change', () => {
        settings.quietPrompts = quietPromptsCheckbox.checked;
        context.saveSettingsDebounced();
    });
    const quietPromptsCheckboxText = document.createElement('span');
    quietPromptsCheckboxText.textContent = context.t`Apply to background prompts`;
    quietPromptsCheckboxLabel.title = context.t`Background prompts = extensions, /commands, etc.`;
    const quietPromptsCheckboxTooltip = document.createElement('span');
    quietPromptsCheckboxTooltip.classList.add('fa-solid', 'fa-circle-info', 'opacity50p');
    quietPromptsCheckboxLabel.append(quietPromptsCheckbox, quietPromptsCheckboxText, quietPromptsCheckboxTooltip);
    inlineDrawerContent.append(quietPromptsCheckboxLabel);

    // Limit
    const parentSelectLabel = document.createElement('label');
    parentSelectLabel.htmlFor = 'messageLimitValue';
    parentSelectLabel.textContent = context.t`Maximum messages to send (-1 = unlimited)`;
    const limitInput = document.createElement('input');
    limitInput.id = 'messageLimitValue';
    limitInput.type = 'number';
    limitInput.min = String(-1);
    limitInput.max = String(100000);
    limitInput.step = String(1);
    limitInput.value = String(settings.limit);
    limitInput.classList.add('text_pole');
    limitInput.addEventListener('input', () => {
        settings.limit = Math.max(-1, Math.round(Number(limitInput.value)));
        context.saveSettingsDebounced();
    });
    inlineDrawerContent.append(parentSelectLabel, limitInput);

    // Image limit
    const imageLimitLabel = document.createElement('label');
    imageLimitLabel.htmlFor = 'messageLimitImageValue';
    imageLimitLabel.textContent = context.t`Most recent images to send (-1 = unlimited)`;
    imageLimitLabel.title = context.t`Older images in the retained messages are dropped before the request is built. Set to -1 to keep all images.`;
    const imageLimitInput = document.createElement('input');
    imageLimitInput.id = 'messageLimitImageValue';
    imageLimitInput.type = 'number';
    imageLimitInput.min = String(-1);
    imageLimitInput.max = String(100000);
    imageLimitInput.step = String(1);
    imageLimitInput.value = String(settings.imageLimit);
    imageLimitInput.classList.add('text_pole');
    imageLimitInput.addEventListener('input', () => {
        settings.imageLimit = Math.max(-1, Math.round(Number(imageLimitInput.value)));
        context.saveSettingsDebounced();
    });
    inlineDrawerContent.append(imageLimitLabel, imageLimitInput);

    // Video limit
    const videoLimitLabel = document.createElement('label');
    videoLimitLabel.htmlFor = 'messageLimitVideoValue';
    videoLimitLabel.textContent = context.t`Most recent videos to send (-1 = unlimited)`;
    videoLimitLabel.title = context.t`Older videos in the retained messages are dropped before the request is built. Set to -1 to keep all videos.`;
    const videoLimitInput = document.createElement('input');
    videoLimitInput.id = 'messageLimitVideoValue';
    videoLimitInput.type = 'number';
    videoLimitInput.min = String(-1);
    videoLimitInput.max = String(100000);
    videoLimitInput.step = String(1);
    videoLimitInput.value = String(settings.videoLimit);
    videoLimitInput.classList.add('text_pole');
    videoLimitInput.addEventListener('input', () => {
        settings.videoLimit = Math.max(-1, Math.round(Number(videoLimitInput.value)));
        context.saveSettingsDebounced();
    });
    inlineDrawerContent.append(videoLimitLabel, videoLimitInput);

    // Image depth
    const imageDepthLabel = document.createElement('label');
    imageDepthLabel.htmlFor = 'messageLimitImageDepth';
    imageDepthLabel.textContent = context.t`Keep images only from the last N messages (-1 = unlimited)`;
    imageDepthLabel.title = context.t`Images on messages older than the Nth most recent are stripped. 1 = only the latest message's images are sent.`;
    const imageDepthInput = document.createElement('input');
    imageDepthInput.id = 'messageLimitImageDepth';
    imageDepthInput.type = 'number';
    imageDepthInput.min = String(-1);
    imageDepthInput.max = String(100000);
    imageDepthInput.step = String(1);
    imageDepthInput.value = String(settings.imageDepth);
    imageDepthInput.classList.add('text_pole');
    imageDepthInput.addEventListener('input', () => {
        settings.imageDepth = Math.max(-1, Math.round(Number(imageDepthInput.value)));
        context.saveSettingsDebounced();
    });
    inlineDrawerContent.append(imageDepthLabel, imageDepthInput);

    // Video depth
    const videoDepthLabel = document.createElement('label');
    videoDepthLabel.htmlFor = 'messageLimitVideoDepth';
    videoDepthLabel.textContent = context.t`Keep videos only from the last N messages (-1 = unlimited)`;
    videoDepthLabel.title = context.t`Videos on messages older than the Nth most recent are stripped. 1 = only the latest message's videos are sent.`;
    const videoDepthInput = document.createElement('input');
    videoDepthInput.id = 'messageLimitVideoDepth';
    videoDepthInput.type = 'number';
    videoDepthInput.min = String(-1);
    videoDepthInput.max = String(100000);
    videoDepthInput.step = String(1);
    videoDepthInput.value = String(settings.videoDepth);
    videoDepthInput.classList.add('text_pole');
    videoDepthInput.addEventListener('input', () => {
        settings.videoDepth = Math.max(-1, Math.round(Number(videoDepthInput.value)));
        context.saveSettingsDebounced();
    });
    inlineDrawerContent.append(videoDepthLabel, videoDepthInput);

    // Note dropped media
    const noteMediaCheckboxLabel = document.createElement('label');
    noteMediaCheckboxLabel.classList.add('checkbox_label', 'marginTop5');
    noteMediaCheckboxLabel.htmlFor = 'messageLimitNoteDroppedMedia';
    noteMediaCheckboxLabel.title = context.t`Adds a note to messages whose images or videos were pruned, so the model knows they were attached.`;
    const noteMediaCheckbox = document.createElement('input');
    noteMediaCheckbox.id = 'messageLimitNoteDroppedMedia';
    noteMediaCheckbox.type = 'checkbox';
    noteMediaCheckbox.checked = settings.noteDroppedMedia;
    noteMediaCheckbox.addEventListener('change', () => {
        settings.noteDroppedMedia = noteMediaCheckbox.checked;
        context.saveSettingsDebounced();
    });
    const noteMediaCheckboxText = document.createElement('span');
    noteMediaCheckboxText.textContent = context.t`Note pruned media in the message`;
    const noteMediaCheckboxTooltip = document.createElement('span');
    noteMediaCheckboxTooltip.classList.add('fa-solid', 'fa-circle-info', 'opacity50p');
    noteMediaCheckboxLabel.append(noteMediaCheckbox, noteMediaCheckboxText, noteMediaCheckboxTooltip);
    inlineDrawerContent.append(noteMediaCheckboxLabel);
}

function addCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ml-state',
        helpString: 'Change the message limit state. If no argument is provided, return the current state.',
        returns: 'boolean',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Desired state of the message limit.',
                typeList: ARGUMENT_TYPE.STRING,
                isRequired: true,
                acceptsMultiple: false,
                enumProvider: commonEnumProviders.boolean('onOffToggle'),
            }),
        ],
        callback: (_, state) => {
            if (state && typeof state === 'string') {
                switch (String(state).trim().toLowerCase()) {
                    case 'toggle':
                    case 't':
                        context.extensionSettings[settingsKey].enabled = !context.extensionSettings[settingsKey].enabled;
                        break;
                    default:
                        context.extensionSettings[settingsKey].enabled = isTrueBoolean(String(state));
                }

                const checkbox = document.getElementById('messageLimitEnabled');
                if (checkbox instanceof HTMLInputElement) {
                    checkbox.checked = context.extensionSettings[settingsKey].enabled;
                    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
                }

                context.saveSettingsDebounced();
            }

            return String(context.extensionSettings[settingsKey].enabled);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ml-quiet',
        helpString: 'Change the message limit state for background (quiet) prompts. If no argument is provided, return the current state.',
        returns: 'boolean',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Desired state of the message limit for background prompts.',
                typeList: ARGUMENT_TYPE.STRING,
                isRequired: true,
                acceptsMultiple: false,
                enumProvider: commonEnumProviders.boolean('onOffToggle'),
            }),
        ],
        callback: (_, state) => {
            if (state && typeof state === 'string') {
                switch (String(state).trim().toLowerCase()) {
                    case 'toggle':
                    case 't':
                        context.extensionSettings[settingsKey].quietPrompts = !context.extensionSettings[settingsKey].quietPrompts;
                        break;
                    default:
                        context.extensionSettings[settingsKey].quietPrompts = isTrueBoolean(String(state));
                }

                const checkbox = document.getElementById('messageLimitQuietPrompts');
                if (checkbox instanceof HTMLInputElement) {
                    checkbox.checked = context.extensionSettings[settingsKey].quietPrompts;
                    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }

            return String(context.extensionSettings[settingsKey].quietPrompts);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ml-media-note',
        helpString: 'Change whether pruned media is noted in the message text. If no argument is provided, return the current state.',
        returns: 'boolean',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Desired state of the pruned media note.',
                typeList: ARGUMENT_TYPE.STRING,
                isRequired: true,
                acceptsMultiple: false,
                enumProvider: commonEnumProviders.boolean('onOffToggle'),
            }),
        ],
        callback: (_, state) => {
            if (state && typeof state === 'string') {
                switch (String(state).trim().toLowerCase()) {
                    case 'toggle':
                    case 't':
                        context.extensionSettings[settingsKey].noteDroppedMedia = !context.extensionSettings[settingsKey].noteDroppedMedia;
                        break;
                    default:
                        context.extensionSettings[settingsKey].noteDroppedMedia = isTrueBoolean(String(state));
                }

                const checkbox = document.getElementById('messageLimitNoteDroppedMedia');
                if (checkbox instanceof HTMLInputElement) {
                    checkbox.checked = context.extensionSettings[settingsKey].noteDroppedMedia;
                }

                context.saveSettingsDebounced();
            }

            return String(context.extensionSettings[settingsKey].noteDroppedMedia);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ml-limit',
        helpString: 'Set the maximum number of messages to send. Use -1 for unlimited. If no argument is provided, return the current limit.',
        returns: 'number',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Maximum number of messages to send. Use -1 for unlimited.',
                typeList: ARGUMENT_TYPE.NUMBER,
                isRequired: true,
                acceptsMultiple: false,
            }),
        ],
        callback: (_, limit) => {
            if (limit && typeof limit === 'string') {
                if (isNaN(Number(limit)) || !isFinite(Number(limit))) {
                    throw new Error('Limit must be a finite number.');
                }

                context.extensionSettings[settingsKey].limit = Math.max(-1, Math.round(Number(limit)));

                const input = document.getElementById('messageLimitValue');
                if (input instanceof HTMLInputElement) {
                    input.value = String(context.extensionSettings[settingsKey].limit);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }

                context.saveSettingsDebounced();
            }

            return String(context.extensionSettings[settingsKey].limit);
        },
    }));

    const addMediaLimitCommand = (name, key, inputId, label) => {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            helpString: `Set the maximum number of most-recent ${label} to send. Use -1 for unlimited. If no argument is provided, return the current limit.`,
            returns: 'number',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: `Maximum number of most-recent ${label} to send. Use -1 for unlimited.`,
                    typeList: ARGUMENT_TYPE.NUMBER,
                    isRequired: true,
                    acceptsMultiple: false,
                }),
            ],
            callback: (_, value) => {
                if (value && typeof value === 'string') {
                    if (isNaN(Number(value)) || !isFinite(Number(value))) {
                        throw new Error('Limit must be a finite number.');
                    }

                    context.extensionSettings[settingsKey][key] = Math.max(-1, Math.round(Number(value)));

                    const input = document.getElementById(inputId);
                    if (input instanceof HTMLInputElement) {
                        input.value = String(context.extensionSettings[settingsKey][key]);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }

                    context.saveSettingsDebounced();
                }

                return String(context.extensionSettings[settingsKey][key]);
            },
        }));
    };

    addMediaLimitCommand('ml-image-limit', 'imageLimit', 'messageLimitImageValue', 'images');
    addMediaLimitCommand('ml-video-limit', 'videoLimit', 'messageLimitVideoValue', 'videos');

    const addMediaDepthCommand = (name, key, inputId, label) => {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            helpString: `Only keep ${label} from the last N messages. Use -1 for unlimited. If no argument is provided, return the current depth.`,
            returns: 'number',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: `Number of most-recent messages to keep ${label} from. Use -1 for unlimited.`,
                    typeList: ARGUMENT_TYPE.NUMBER,
                    isRequired: true,
                    acceptsMultiple: false,
                }),
            ],
            callback: (_, value) => {
                if (value && typeof value === 'string') {
                    if (isNaN(Number(value)) || !isFinite(Number(value))) {
                        throw new Error('Depth must be a finite number.');
                    }

                    context.extensionSettings[settingsKey][key] = Math.max(-1, Math.round(Number(value)));

                    const input = document.getElementById(inputId);
                    if (input instanceof HTMLInputElement) {
                        input.value = String(context.extensionSettings[settingsKey][key]);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }

                    context.saveSettingsDebounced();
                }

                return String(context.extensionSettings[settingsKey][key]);
            },
        }));
    };

    addMediaDepthCommand('ml-image-depth', 'imageDepth', 'messageLimitImageDepth', 'images');
    addMediaDepthCommand('ml-video-depth', 'videoDepth', 'messageLimitVideoDepth', 'videos');
}

(function initExtension() {
    if (!context.extensionSettings[settingsKey]) {
        context.extensionSettings[settingsKey] = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (context.extensionSettings[settingsKey][key] === undefined) {
            context.extensionSettings[settingsKey][key] = defaultSettings[key];
        }
    }

    addSettings();
    addCommands();
})();
