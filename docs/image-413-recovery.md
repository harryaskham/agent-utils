# Reactive image-read 413 recovery

`extensions/image-413-recovery.js` repairs the failure mode where a built-in image `read` succeeds locally but the resulting provider request is rejected with HTTP 413. This complements the managed Cacophony pre-read image guard: the pre-read guard catches known large files, while reactive recovery handles compressed/high-resolution images and provider-specific payload limits that cannot be predicted reliably from file bytes alone.

## Recovery sequence

The extension tracks only the latest completed `read` tool result that contains an image block.

- A successful subsequent provider response clears that candidate.
- A provider HTTP 413 while the candidate is pending activates recovery.
- Unrelated 400/401/429/5xx responses and 413 responses without a pending image read are untouched.

On recovery it:

1. identifies the original image dimensions;
2. creates a PNG at exactly `floor(width/2) × floor(height/2)` under `.pi/image-guard/previews/`, without modifying the original;
3. records a durable recovery entry keyed by the exact read `toolCallId`;
4. replaces that tool result's image content in every future provider-context copy with:

   ```text
   Image read failed: 413 Request Entity Too Large. A resized version is available at: <path>
   ```

5. queues one hidden follow-up turn so the agent can continue with the repaired context.

The hidden trigger is removed by the same context hook. Older successful tool images, user image messages, and unrelated read results remain untouched.

## Resize tools

PNG dimensions are read directly from the 24-byte IHDR header. Other formats use `magick identify`, legacy `identify`, or macOS `sips`. Resizing tries:

1. `magick`
2. `convert`
3. macOS `sips`

Commands are bounded to 15 seconds. The generated filename includes a content/metadata-derived hash and `.half.png`. The original remains available for deliberate cropping or further resizing.

If dimensions or resize tooling fail, the image attachment is still pruned from provider context and replaced with bounded text describing the resize failure. Command stderr is not copied into model context.

## Retry and persistence

Each `toolCallId` can recover only once. Repeated 413 hooks cannot create another resize or retry for the same image.

Recovery metadata is stored as a custom session entry. On reload/restart, the context hook restores that fence and continues replacing the exact failed historical image result, so resuming the session cannot reintroduce the oversized payload. The original session entry remains intact on disk for auditability; pruning occurs in the provider-context copy, while the durable replacement entry records the safe preview path.

Use `/image-413-recovery` to show the latest recovery and preview path.
