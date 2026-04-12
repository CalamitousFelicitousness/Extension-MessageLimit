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
 */
const defaultSettings = Object.freeze({
    enabled: false,
    quietPrompts: false,
    limit: 10,
    imageLimit: -1,
    videoLimit: -1,
    imageDepth: -1,
    videoDepth: -1,
});

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

    // Returns true if this media item should be dropped from the request.
    // Depth cutoffs are applied first (positional: relative to the end of
    // the retained chat), then the per-type count cutoffs. Only items that
    // survive both checks bump the counter, so limits reflect what is
    // actually being sent rather than what is stored on the messages.
    const shouldDrop = (item, msgIdx) => {
        if (!item) return false;
        const depth = chat.length - 1 - msgIdx;
        if (item.type === 'image') {
            if (pruneImageDepth && depth >= imageDepth) return true;
            if (pruneImages) {
                if (imagesKept >= imageLimit) return true;
                imagesKept++;
            }
            return false;
        }
        if (item.type === 'video') {
            if (pruneVideoDepth && depth >= videoDepth) return true;
            if (pruneVideos) {
                if (videosKept >= videoLimit) return true;
                videosKept++;
            }
            return false;
        }
        return false;
    };

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        const media = message?.extra?.media;
        if (!Array.isArray(media) || media.length === 0) {
            continue;
        }

        const mediaDisplay = message.extra.media_display || 'list';

        if (mediaDisplay === 'gallery') {
            const idx = Number.isInteger(message.extra.media_index) ? message.extra.media_index : 0;
            const selected = media[idx];
            if (shouldDrop(selected, i)) {
                // Gallery mode sends only the indexed item, so dropping it
                // means the message contributes no media at all.
                chat[i] = { ...message, extra: { ...message.extra, media: [], media_index: 0 } };
            }
            continue;
        }

        const filteredMedia = [];
        for (const item of media) {
            if (!shouldDrop(item, i)) {
                filteredMedia.push(item);
            }
        }
        if (filteredMedia.length !== media.length) {
            chat[i] = { ...message, extra: { ...message.extra, media: filteredMedia } };
        }
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
