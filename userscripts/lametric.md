# LaMetric → AWTRIX UserScript Implementation Plan

## Overview

A Tampermonkey userscript that adds "Send to AWTRIX" buttons to the LaMetric icon browser, allowing users to preview any LaMetric icon on their AWTRIX 3 device in real-time.

## Target URL
- `https://developer.lametric.com/icons*` (icon search/browse pages)
- `https://developer.lametric.com/content/apps/icon_thumbs/*` (direct icon URLs)

---

## Part 1: DOM Injection - Adding Buttons to Icon Previews

### Goal
For every icon preview on the LaMetric developer site, inject a small "Send to AWTRIX" button.

### LaMetric Page Structure (Observed)
```html
<div class="one" data-id="9389" data-type="0" data-name="bunny" data-category="animals" data-version="1">
  <div class="img-box" id="9389_img">
    <img src="/content/apps/icon_thumbs/9389_icon_thumb.png?v=1" title="bunny">
  </div>
  <div class="subtitle">#9389</div>
  <div class="title">bunny</div>
</div>
```

### Icon URL Pattern
From the `data-id` attribute, construct the full icon URL:
```
https://developer.lametric.com/content/apps/icon_thumbs/{data-id}.png
```

Note: The thumbnail (`*_icon_thumb.png`) is lower resolution. Use the full PNG for better AWTRIX rendering.

### Implementation Approach
1. **Wait for page load**: LaMetric may use lazy loading or AJAX for icons
2. **MutationObserver**: Watch for new `.one` elements being added to the DOM
3. **Inject button**: Add a small button to each `.one` div
4. **Button styling**: Position absolute or inline, AWTRIX blue color (#00A8E8)

```javascript
// MutationObserver pattern for dynamic content
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.classList && node.classList.contains('one')) {
        injectButton(node);
      }
    });
  });
});
observer.observe(document.body, { childList: true, subtree: true });
```

---

## Part 2: Icon Fetching & Processing

### Goal
Download the PNG, resize it to AWTRIX-compatible dimensions, and convert to RGB888 bitmap format.

### AWTRIX Display Specs
- Resolution: 32x8 pixels (width x height)
- Color depth: RGB888 (3 bytes per pixel)
- Format for `db` command: `[x, y, w, h, [r, g, b, r, g, b, ...]]`

### Processing Pipeline

#### Step 2.1: Fetch Icon
```javascript
const iconId = element.getAttribute('data-id');
const iconUrl = `https://developer.lametric.com/content/apps/icon_thumbs/${iconId}.png`;

// Fetch as blob
const response = await fetch(iconUrl);
const blob = await response.blob();
```

#### Step 2.2: Process with Canvas API (8x8 → Centered on 32x8)
LaMetric icons are **8x8 pixels**. AWTRIX is **32x8 pixels**. We center the icon:

```
AWTRIX 32x8 display:
<--- 12px ---> <--- 8px icon ---> <--- 12px --->
     [0,0]          [12,0]            [20,0]
```

```javascript
function processIcon(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Create 32x8 canvas for full AWTRIX display
      canvas.width = 32;
      canvas.height = 8;
      
      // Fill with black (or transparent)
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 32, 8);
      
      // Draw 8x8 icon centered at x=12
      ctx.drawImage(img, 12, 0, 8, 8);
      
      // Extract only the 8x8 icon pixels (not the full 32x8)
      // For efficiency, we only send the icon pixels, positioned via x,y in db command
      const iconCanvas = document.createElement('canvas');
      iconCanvas.width = 8;
      iconCanvas.height = 8;
      const iconCtx = iconCanvas.getContext('2d');
      iconCtx.drawImage(img, 0, 0, 8, 8);
      
      const imageData = iconCtx.getImageData(0, 0, 8, 8);
      const pixels = imageData.data;
      
      // Convert to RGB888 array (64 pixels × 3 bytes = 192 bytes)
      const rgbArray = [];
      for (let i = 0; i < pixels.length; i += 4) {
        rgbArray.push(pixels[i]);     // R
        rgbArray.push(pixels[i + 1]); // G
        rgbArray.push(pixels[i + 2]); // B
      }
      
      resolve({
        width: 8,
        height: 8,
        bitmap: rgbArray  // 192 bytes total
      });
    };
    img.src = URL.createObjectURL(blob);
  });
}
```

#### Step 2.3: Construct AWTRIX Drawing Instructions
Position the 8x8 icon at x=12 to center it on the 32x8 display.

**Method: Individual Pixel Drawing (`dp`)**

Due to bitmap (`db`) compatibility issues, we use individual pixel commands instead:

```javascript
function createAwtrixPayload(rgbArray) {
  const drawCommands = [];
  
  // Convert RGB888 array to individual pixel commands
  // rgbArray has 192 values (8×8 pixels × 3 bytes RGB)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const pixelIndex = (y * 8 + x) * 3;
      const r = rgbArray[pixelIndex];
      const g = rgbArray[pixelIndex + 1];
      const b = rgbArray[pixelIndex + 2];
      
      // Convert RGB to hex color
      const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      
      // Draw pixel at position (x+12, y) to center on 32x8 display
      drawCommands.push({
        dp: [x + 12, y, color]  // x, y, color
      });
    }
  }
  
  return {
    draw: drawCommands,
    duration: 5
  };
}
```

**Why `dp` instead of `db`?**
- ✅ More reliable across AWTRIX firmware versions
- ✅ Easier to debug (each pixel is explicit)
- ✅ No bitmap format compatibility issues
- ⚠️ Larger payload (64 commands vs 1 bitmap command)
- ⚠️ Slightly slower rendering (negligible for 8x8)

#### Step 2.4: Animated GIF Support (Hover-Loop Mode)

For animated icons (identified by `data-type="1"`), use a **hover-based loop** for better UX:

**User Interaction:**
1. **Click** "Send to AWTRIX" → Extracts frames, starts animation loop
2. **Hover** over button → Animation continues looping
3. **Mouse leaves** button → Animation stops immediately

```javascript
let animationLoop = null;
let currentFrames = null;

async function handleAnimatedIcon(iconId, button) {
  // Extract frames once
  const gifData = await fetchIcon(iconId, '.gif');
  currentFrames = await extractGifFrames(gifData);
  
  // Start animation loop
  let frameIndex = 0;
  animationLoop = setInterval(async () => {
    // Send current frame with stack:false for instant replacement
    const payload = {
      ...createAwtrixPayload(currentFrames[frameIndex].rgbArray),
      stack: false  // Immediately replace current notification
    };
    await sendToAwtrix(payload);
    
    // Next frame (loop back to start)
    frameIndex = (frameIndex + 1) % currentFrames.length;
    button.textContent = `🎬 Frame ${frameIndex + 1}/${currentFrames.length}`;
  }, GM_getValue('frame_delay', 200)); // Configurable delay (default 200ms)
}

// Stop animation when mouse leaves button
button.onmouseleave = () => {
  if (animationLoop) {
    clearInterval(animationLoop);
    animationLoop = null;
    button.textContent = '📡';
  }
};
```

**Frame Extraction:**
- Parse GIF using `omggif` library via `@require` (Tampermonkey-compatible)
- Decode each frame to RGBA pixel data with `decodeAndBlitFrameRGBA()`
- Scale frames to 8x8 using canvas
- Convert each frame to RGB888 array
- Store frames for continuous looping

**Library Choice:** `omggif` loaded from unpkg.com via `@require` directive. Tampermonkey supports external libraries!

**Configurable Frame Delay:**
User can set animation speed via Tampermonkey menu:
- Default: 200ms between frames
- Range: 50ms (fast) to 2000ms (slow)
- Stored persistently with `GM_setValue`

**Instant Display with `stack: false`:**
All payloads (static and animated) use `stack: false` for instant display:
```javascript
const payload = {
  draw: [...],
  duration: 5,
  stack: false  // Immediately replace current notification (no stacking)
};
```

**Why `stack: false` for everything:**
- ✅ Instant display (no delay)
- ✅ Replaces any existing notification immediately
- ✅ No need to clear before sending
- ✅ Consistent behavior for static and animated icons
- ✅ Built-in AWTRIX feature

---

## Part 3: AWTRIX HTTP API & Device Discovery

### AWTRIX HTTP API Endpoints (Found in Codebase)

Based on analysis of `icons/dev/awtrixPreview.html` and `icons/upload_icon.sh`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `http://{IP}/api/screen` | GET | Returns current display pixels as RGB565 array (32x8 = 256 values) |
| `http://{IP}/api/previousapp` | POST | Switch to previous app |
| `http://{IP}/api/nextapp` | POST | Switch to next app |
| `http://{IP}/edit` | POST | Upload GIF icon files (multipart/form-data) |

**Note:** The `/api/notify` endpoint mentioned in docs may not exist as a standalone HTTP endpoint. Notifications appear to go through MQTT primarily.

### Auto-Discovery Options

#### Option 1: IP Range Scanning (Browser Limitations)
From a Tampermonkey userscript, we can attempt to discover AWTRIX devices by scanning common local IP ranges:

```javascript
// Scan common local ranges
const ranges = ['192.168.1', '192.168.0', '10.0.0'];
const commonIPs = [];

// Generate IPs to check
for (const range of ranges) {
  for (let i = 1; i <= 254; i++) {
    commonIPs.push(`${range}.${i}`);
  }
}

// Try to connect to /api/screen with short timeout
async function checkAwtrix(ip) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const response = await fetch(`http://${ip}/api/screen`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (response.ok) {
      return ip; // Found an AWTRIX device!
    }
  } catch (e) {
    // Not an AWTRIX device or not reachable
  }
  return null;
}

// Run checks in parallel batches
const foundDevices = [];
const batchSize = 10;
for (let i = 0; i < commonIPs.length; i += batchSize) {
  const batch = commonIPs.slice(i, i + batchSize);
  const results = await Promise.all(batch.map(checkAwtrix));
  foundDevices.push(...results.filter(ip => ip !== null));
}
```

**Limitations:**
- CORS will block cross-origin requests to local IPs from `developer.lametric.com`
- Requires `@connect *` Tampermonkey permission
- May be slow (254 IPs × 500ms timeout = ~2 minutes worst case)
- Userscript may need to be running on a page that allows local network access

#### Option 2: Manual IP Configuration (Recommended)
Store the AWTRIX device IP in Tampermonkey storage:

```javascript
// Simple prompt-based config
GM_registerMenuCommand('Set AWTRIX IP', () => {
  const currentIP = GM_getValue('awtrix_ip', '');
  const newIP = prompt('Enter AWTRIX device IP:', currentIP);
  if (newIP && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(newIP)) {
    GM_setValue('awtrix_ip', newIP);
    alert(`AWTRIX IP set to: ${newIP}`);
  }
});
```

#### Option 3: Home Assistant Integration (For HA Users)
If user has Home Assistant with AWTRIX devices already configured:

```javascript
// Query HA for AWTRIX devices via websocket
// HA device registry entries have:
// - manufacturer: "Blueforcer"
// - model: "AWTRIX 3"
// - configuration_url: contains IP address
```

From the blueprints (`awtrix_binary_sensor.yaml`), AWTRIX devices in HA are identified by:
- Integration: `mqtt`
- Manufacturer: `Blueforcer`
- Model: `AWTRIX 3`

### Recommended Implementation
**Hybrid approach:**
1. Allow manual IP entry via Tampermonkey menu
2. Store IP persistently with `GM_setValue`
3. Add a "Test Connection" button that tries `/api/screen`
4. Future: Optional HA integration for auto-discovery

---

## Part 4: Sending Icons to AWTRIX

### Challenge
The LaMetric icons are **8x8 pixels**, but AWTRIX display is **32x8 pixels**.

### Approach: Center the 8x8 Icon on 32x8 Display

Position the icon at x=12 (centered with padding on both sides):

```
32 pixels wide total
<--- 12px padding ---> <--- 8px icon ---> <--- 12px padding -->
[         ][icon 8x8][          ]
```

### Method 1: HTTP API (RECOMMENDED ✅)

**Why HTTP is better:**
- ✅ No MQTT authentication needed
- ✅ No WebSocket configuration
- ✅ No external library dependencies (Paho MQTT)
- ✅ Simple fire-and-forget with native `fetch()`
- ✅ Only requires AWTRIX device IP address

**Endpoint:** `POST http://{AWTRIX_IP}/api/notify`

Per [AWTRIX 3 API docs](https://blueforcer.github.io/awtrix3/#/api?id=custom-apps-and-notifications), the `/api/notify` endpoint accepts drawing instructions:

```javascript
async function sendToAwtrix(rgbArray) {
  const ip = GM_getValue('awtrix_ip');
  if (!ip) {
    alert('Please configure AWTRIX IP in Tampermonkey menu');
    return;
  }
  
  // Convert RGB888 array to individual pixel draw commands
  const drawCommands = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const pixelIndex = (y * 8 + x) * 3;
      const r = rgbArray[pixelIndex];
      const g = rgbArray[pixelIndex + 1];
      const b = rgbArray[pixelIndex + 2];
      const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      drawCommands.push({dp: [x + 12, y, color]});  // Center at x=12
    }
  }
  
  const payload = {
    draw: drawCommands,
    duration: 5
  };
  
  try {
    const response = await fetch(`http://${ip}/api/notify`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      console.log('✅ Icon sent to AWTRIX');
    } else {
      console.error('❌ AWTRIX error:', response.status);
    }
  } catch (error) {
    console.error('❌ Failed to reach AWTRIX:', error);
    alert('Could not connect to AWTRIX. Check IP address and network.');
  }
}
```

**Configuration:**
```javascript
// Simple IP storage via Tampermonkey menu
GM_registerMenuCommand('Set AWTRIX IP', () => {
  const currentIP = GM_getValue('awtrix_ip', '');
  const newIP = prompt('Enter AWTRIX device IP address:', currentIP);
  if (newIP && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(newIP)) {
    GM_setValue('awtrix_ip', newIP);
    alert(`✅ AWTRIX IP set to: ${newIP}`);
  } else if (newIP) {
    alert('❌ Invalid IP address format');
  }
});
```

### Method 2: MQTT (Optional - Not Recommended)

Only use if HTTP doesn't work for some reason. Requires:
- MQTT broker with WebSocket support
- Username/password authentication
- Paho MQTT library
- Topic prefix configuration

See original plan for MQTT implementation details.

---

## Part 5: User Interface Elements

### Required UI Components

#### Button Layout (Per Icon)

Buttons appear **below each icon**, between the image and the subtitle:

```
┌─────────────┐
│   [Icon]    │  ← LaMetric icon image (visible, not blocked)
├─────────────┤
│  📡    📋   │  ← Buttons (centered, below image)
├─────────────┤
│   #9389     │  ← Icon ID
│   bunny     │  ← Icon name
└─────────────┘
```

**Implementation:**
- Buttons inserted into DOM after `.img-box`, before `.subtitle`
- Centered with `justify-content: center`
- Compact emoji-only labels (📡 and 📋) to save space
- Tooltips on hover for full descriptions

#### 1. **"Send to AWTRIX" Button** (📡)
   - **Label:** 📡 (satellite emoji)
   - **Tooltip:** "Send to AWTRIX"
   - **Color:** AWTRIX blue (#00A8E8)
   - **Action (Static Icons):** Click → fetch icon → convert → POST to AWTRIX
   - **Action (Animated Icons):** Click → start loop → hover to continue → leave to stop
   - **States (Static):**
     - Default: 📡
     - Loading: ⏳ Sending...
     - Success: ✅ Sent! (2 sec)
     - Error: ❌ Failed (2 sec)
   - **States (Animated):**
     - Default: 📡
     - Loading: ⏳ Loading...
     - Animating: 🎬 1/N, 🎬 2/N, ... (loops while hovering)
     - Stopped: 📡 (when mouse leaves)

#### 2. **"Export Icon" Button** (📋)
   - **Label:** 📋 (clipboard emoji)
   - **Tooltip:** "Copy JSON payload to clipboard"
   - **Color:** Green (#4CAF50)
   - **Action:** Click → fetch icon → convert → copy JSON to clipboard
   - **States:**
     - Default: 📋
     - Loading: ⏳ Processing...
     - Success: ✅ Copied! (2 sec)
     - Error: ❌ Failed (2 sec)
   
   **Example copied payload:**
   ```json
   {
     "draw": [
       {"dp": [12, 0, "#ff0000"]},
       {"dp": [13, 0, "#ff0000"]},
       {"dp": [14, 0, "#00ff00"]},
       ...
       {"dp": [19, 7, "#0000ff"]}
     ],
     "duration": 5
   }
   ```
   
   _(64 `dp` commands total for 8×8 icon, centered at x=12)_
   
   **Use cases:**
   - Manual testing with curl/Postman
   - Creating custom automations in Home Assistant
   - Debugging payload format

#### 3. **Configuration via Tampermonkey Menu**
   - ⚙️ **"Set AWTRIX IP"** - Prompt for IP address with validation
   - 🔍 **"Test AWTRIX Connection"** - Verify reachability via `/api/screen` GET request
   - ⏱️ **"Set Animation Speed"** - Configure frame delay (50-2000ms, default 200ms)

### Tampermonkey UI Capabilities
- `GM_registerMenuCommand()` - Add items to Tampermonkey menu
- `GM_setValue()` / `GM_getValue()` - Persistent storage
- Standard DOM manipulation for modals/overlays
- `@require` for external libraries (jQuery, Paho MQTT, etc.)

---

## Part 6: Userscript Metadata & Dependencies

### Required Tampermonkey Headers
```javascript
// ==UserScript==
// @name         LaMetric to AWTRIX Sender
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Send LaMetric icons to AWTRIX 3 displays via HTTP (with animated GIF support)
// @author       Your Name
// @match        https://developer.lametric.com/icons*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @require      https://unpkg.com/omggif@1.0.10/omggif.js
// ==/UserScript==
```

**Grants explained:**
- `GM_setValue`/`GM_getValue` - Persistent storage for AWTRIX IP
- `GM_registerMenuCommand` - Add "Set AWTRIX IP" to Tampermonkey menu
- `GM_xmlhttpRequest` - CORS bypass for fetching icons and sending to AWTRIX
- `GM_setClipboard` - Copy JSON payload to clipboard (Export Icon feature)
- `@connect *` - Allow connections to any IP (user's local network)
- `@require omggif` - GIF parsing library from unpkg.com for animated icon support

---

## Part 7: Implementation Phases

### Phase 1: MVP (Minimum Viable Product) - HTTP Only
1. DOM injection of two buttons on each LaMetric icon preview:
   - **"Send to AWTRIX"** - Sends icon to device
   - **"Export Icon"** - Copies JSON payload to clipboard
2. Canvas-based PNG → RGB888 conversion (8x8 icons)
3. Manual AWTRIX IP configuration via Tampermonkey menu
4. HTTP POST to `/api/notify` with drawing instructions
5. Clipboard copy functionality with `GM_setClipboard`
6. Simple success/error feedback (console + alert)

### Phase 2: Enhanced UX
1. Configuration UI with validation and test connection button
2. Visual feedback (button state changes, loading spinner)
3. Preview modal (show how icon will look on 32x8 display before sending)
4. Error handling improvements (network timeout, invalid IP, etc.)
5. **Animated GIF support** - Sequential frame sending with configurable delay

### Phase 3: Integration Features
1. Home Assistant integration option
2. Icon library/favorites (store icon IDs locally)
3. Batch operations (send multiple icons)

---

## Part 8: Error Handling & Edge Cases

### Known Challenges (HTTP Approach)
1. **CORS on LaMetric CDN** - Fetching icons from `developer.lametric.com` cross-origin
   - Solution: Use `GM_xmlhttpRequest` with Tampermonkey's CORS bypass
2. **CORS to local AWTRIX** - Browser blocks `http://192.168.x.x` from HTTPS page
   - Solution: `@connect *` grant + `GM_xmlhttpRequest` for local network access
3. **Canvas tainted** - If LaMetric images lack CORS headers, canvas extraction fails
   - Solution: Fetch via `GM_xmlhttpRequest` as blob, create blob URL for canvas
4. **Icon size variations** - LaMetric has 8x8 icons (confirmed), but some may be larger
   - Solution: Always resize to 8x8 via canvas, then center at x=12 on AWTRIX

### Error Scenarios
- **AWTRIX offline/unreachable** - Network timeout, wrong IP
- **Invalid IP format** - User enters malformed IP
- **Icon fetch failure** - LaMetric CDN down or icon deleted
- **Canvas processing error** - Invalid image format
- **HTTP 4xx/5xx from AWTRIX** - Device error or malformed payload

---

## Part 9: Security Considerations

1. **IP Address Storage**
   - AWTRIX IP stored in `GM_getValue` (browser-encrypted storage)
   - No authentication credentials needed (local network trust model)
   
2. **CORS Handling**
   - `@connect *` allows connections to any host (required for user-configured IPs)
   - Validate IP format before attempting connection
   - Only send to `http://` endpoints (AWTRIX doesn't use HTTPS)

3. **Payload Validation**
   - Sanitize icon data to prevent malformed JSON
   - Limit RGB array size (8×8×3 = 192 bytes max)
   - Validate drawing command structure before sending

---

## Appendix A: AWTRIX Drawing Command Reference

| Command | Parameters | Description |
|---------|-----------|-------------|
| `dp` | `[x, y, color]` | Draw pixel |
| `dl` | `[x0, y0, x1, y1, color]` | Draw line |
| `dr` | `[x, y, w, h, color]` | Draw rectangle (outline) |
| `df` | `[x, y, w, h, color]` | Draw filled rectangle |
| `dc` | `[x, y, r, color]` | Draw circle (outline) |
| `dfc` | `[x, y, r, color]` | Draw filled circle |
| `dt` | `[x, y, text, color]` | Draw text |
| `db` | `[x, y, w, h, [rgb...]]` | Draw RGB888 bitmap |

**Color formats:** Hex string `"#FF0000"` or RGB array `[255, 0, 0]`

---

## Appendix B: Testing Checklist

### Static Icons (PNG)
- [ ] Two buttons appear on all icon previews: "Send to AWTRIX" and "Export Icon"
- [ ] Buttons positioned below icon, not overlaying the image
- [ ] Icon fetch works via `GM_xmlhttpRequest` (CORS bypass)
- [ ] 8x8 PNG → RGB888 → hex color conversion produces correct colors
- [ ] Payload contains 64 `dp` commands (one per pixel)
- [ ] Payload includes `stack: false` for instant display
- [ ] HTTP POST to `/api/notify` succeeds with valid IP
- [ ] AWTRIX displays icon left-aligned (x=0) instantly (no delay)
- [ ] Icon replaces any existing notification immediately
- [ ] Export Icon button copies valid JSON payload to clipboard
- [ ] Copied payload uses `dp` commands and `stack: false`
- [ ] Copied payload can be used with curl/Postman to send to AWTRIX

### Animated Icons (GIF) - Hover-Loop Mode
- [ ] Animated icons detected via `data-type="1"` attribute
- [ ] GIF frames extracted successfully using omggif library
- [ ] Console shows: "GIF info: WxH, N frames" and "Starting animation loop"
- [ ] Click starts animation loop
- [ ] Button shows: "🎬 1/N", "🎬 2/N", etc. (cycling)
- [ ] Animation loops continuously while hovering over button
- [ ] Mouse leaving button stops animation immediately
- [ ] Console shows: "🛑 Animation stopped (mouse left button)"
- [ ] Frame delay configurable via Tampermonkey menu (default 200ms)
- [ ] Frames use `stack: false` for instant replacement (no clearing needed)
- [ ] Smooth animation with no flicker between frames

### General
- [ ] All payloads use `stack: false` (static and animated)
- [ ] Icons display instantly without delay
- [ ] No notification stacking or overlap
- [ ] Error messages are helpful (network errors, invalid IP, etc.)
- [ ] IP configuration persists across page reloads
- [ ] Test connection button validates AWTRIX reachability
- [ ] Animation speed configuration persists across page reloads

---

## Open Questions → Decisions

Based on user feedback, the following decisions have been made:

| Question | Decision |
|----------|----------|
| **Communication Method** | ✅ **HTTP API** (not MQTT). Simpler, no auth needed, just IP address. |
| **AWTRIX HTTP API** | ✅ Confirmed `/api/notify` endpoint exists per [official docs](https://blueforcer.github.io/awtrix3/#/api?id=custom-apps-and-notifications). |
| **Drawing Method** | ✅ **Individual pixel drawing (`dp`)** instead of bitmap (`db`) for better compatibility. |
| **Animated Icons** | ✅ **Implemented!** GIF frames extracted via gifuct-js, sent sequentially with 500ms delay. |
| **Icon Size** | LaMetric icons are 8x8. **Left-aligned at x=0** on the 32x8 AWTRIX display. |
| **Multiple Devices** | ❌ Single device support only. Manual IP configuration via Tampermonkey menu. |
| **Authentication** | ✅ None needed. AWTRIX HTTP API is unauthenticated (local network trust). |

---

## Implementation Summary

**MVP Approach:**
1. User configures AWTRIX IP once via Tampermonkey menu
2. Buttons appear on every LaMetric icon preview
3. Click button → fetch PNG → convert to RGB888 → POST to `http://{IP}/api/notify`
4. Icon appears centered on AWTRIX for 5 seconds

**No dependencies, no MQTT, no auth - just HTTP!**
