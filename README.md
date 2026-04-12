# Message Limit

> This is a fork of [SillyTavern/Extension-MessageLimit](https://github.com/SillyTavern/Extension-MessageLimit) with added per-type media pruning. See [Media pruning](#media-pruning) below.

Limit the maximum number of visible chat messages to be sent per prompt. Does not include example messages, in-chat injections, etc.

## How to use

1. Install the extension via the URL: `https://github.com/CalamitousFelicitousness/Extension-MessageLimit`
2. Enable the extension in the extension settings menu. Set the message limit to your desired value (default: 10).
3. If you need to apply the message limit to background/quiet prompts (e.g. extensions, slash commands, etc.), enable the "Apply to background prompts" setting.

## Media pruning

Four extra settings control how attached images and videos in the retained chat history are sent to the model. All default to `-1` (unlimited), preserving the upstream behavior.

- **Most recent images/videos to send** (`imageLimit`, `videoLimit`) - cap on how many of the most-recent media items of each type are kept. `0` drops all of that type.
- **Keep images/videos only from the last N messages** (`imageDepth`, `videoDepth`) - positional cutoff. `1` means only the latest message's media of that type is sent. Useful for sending a video once and then chatting without resending it every turn.

Depth cutoffs run before count cutoffs, so the two compose.

## Slash Commands

### `/ml-state`

Enable or disable the message limit. Just returns the current state if no arguments are provided.

```stscript
/ml-state toggle
```

```stscript
/ml-state | /echo
```

### `/ml-limit`

Set the message limit. Use `-1` for unlimited. Just returns the current limit if no arguments are provided.

```stscript
/ml-limit 5
```

```stscript
/ml-limit | /echo
```

### `/ml-quiet`

Enable or disable the message limit for background (quiet) prompts. Just returns the current state if no arguments are provided.

```stscript
// Summarize only the last 5 messages ||
/ml-state on | /ml-limit 5 | /ml-quiet on | /summarize | /ml-state off
```

### `/ml-image-limit`

Set the maximum number of most-recent images to keep in the request. Use `-1` for unlimited. Just returns the current limit if no arguments are provided.

```stscript
/ml-image-limit 2
```

### `/ml-video-limit`

Set the maximum number of most-recent videos to keep in the request. Use `-1` for unlimited. Just returns the current limit if no arguments are provided.

```stscript
/ml-video-limit 1
```

### `/ml-image-depth`

Only keep images from the last N messages. Use `-1` for unlimited. Just returns the current depth if no arguments are provided.

```stscript
/ml-image-depth 1
```

### `/ml-video-depth`

Only keep videos from the last N messages. Use `-1` for unlimited. Just returns the current depth if no arguments are provided.

```stscript
/ml-video-depth 1
```

## License

AGPL-3.0
