// ==UserScript==
// @name         LaMetric to AWTRIX Sender
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Send LaMetric icons to AWTRIX 3 displays via HTTP (with animated GIF support)
// @author       jeeftor
// @match        https://developer.lametric.com/icons*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @require      https://unpkg.com/omggif@1.0.10/omggif.js
// ==/UserScript==

(function() {
    'use strict';

    // ========================================================================
    // CONFIGURATION
    // ========================================================================

    const CONFIG = {
        AWTRIX_ICON_WIDTH: 8,
        AWTRIX_ICON_HEIGHT: 8,
        AWTRIX_DISPLAY_WIDTH: 32,
        AWTRIX_DISPLAY_HEIGHT: 8,
        ICON_X_OFFSET: 0, // Left-align 8x8 icon on 32x8 display
        ICON_Y_OFFSET: 0,
        DEFAULT_DURATION: 5, // seconds
        FRAME_DELAY: 500, // milliseconds between animated frames
        BUTTON_STYLE: `
            display: inline-block;
            padding: 4px 8px;
            margin: 2px;
            font-size: 11px;
            font-weight: bold;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            text-align: center;
            transition: opacity 0.2s;
        `,
        SEND_BUTTON_COLOR: '#00A8E8', // AWTRIX blue
        EXPORT_BUTTON_COLOR: '#4CAF50' // Green
    };

    // ========================================================================
    // TAMPERMONKEY MENU COMMANDS
    // ========================================================================

    GM_registerMenuCommand('⚙️ Set AWTRIX IP', setAwtrixIP);
    GM_registerMenuCommand('🔍 Test AWTRIX Connection', testConnection);
    GM_registerMenuCommand('⏱️ Set Animation Speed', setFrameDelay);

    function setAwtrixIP() {
        const currentIP = GM_getValue('awtrix_ip', '');
        const newIP = prompt('Enter AWTRIX device IP address:', currentIP);
        
        if (newIP === null) return; // User cancelled
        
        if (newIP && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(newIP)) {
            GM_setValue('awtrix_ip', newIP);
            alert(`✅ AWTRIX IP set to: ${newIP}\n\nYou can now send icons to your AWTRIX device!`);
        } else if (newIP) {
            alert('❌ Invalid IP address format.\n\nPlease use format: 192.168.1.100');
        }
    }

    function testConnection() {
        const ip = GM_getValue('awtrix_ip');
        if (!ip) {
            alert('❌ No AWTRIX IP configured.\n\nPlease set IP address first via Tampermonkey menu.');
            return;
        }

        console.log(`Testing connection to AWTRIX at ${ip}...`);

        GM_xmlhttpRequest({
            method: 'GET',
            url: `http://${ip}/api/screen`,
            timeout: 5000,
            onload: function(response) {
                if (response.status === 200) {
                    alert(`✅ Connection successful!\n\nAWTRIX device at ${ip} is reachable.`);
                    console.log('✅ AWTRIX connection test passed');
                } else {
                    alert(`⚠️ Unexpected response from AWTRIX.\n\nStatus: ${response.status}\nDevice may not be an AWTRIX 3.`);
                    console.warn('AWTRIX test response:', response);
                }
            },
            onerror: function(error) {
                alert(`❌ Connection failed!\n\nCould not reach AWTRIX at ${ip}.\n\nCheck:\n- IP address is correct\n- AWTRIX is powered on\n- Both devices on same network`);
                console.error('AWTRIX connection test failed:', error);
            },
            ontimeout: function() {
                alert(`⏱️ Connection timeout!\n\nAWTRIX at ${ip} did not respond.\n\nCheck network connection.`);
                console.error('AWTRIX connection timeout');
            }
        });
    }

    function setFrameDelay() {
        const currentDelay = GM_getValue('frame_delay', 200);
        const newDelay = prompt(
            'Enter animation frame delay in milliseconds:\n\n' +
            '• 50ms = Very Fast\n' +
            '• 100ms = Fast\n' +
            '• 200ms = Normal (default)\n' +
            '• 500ms = Slow\n' +
            '• 1000ms = Very Slow',
            currentDelay
        );
        
        if (newDelay === null) return; // User cancelled
        
        const delay = parseInt(newDelay);
        if (!isNaN(delay) && delay >= 50 && delay <= 2000) {
            GM_setValue('frame_delay', delay);
            alert(`✅ Animation speed set to ${delay}ms between frames`);
        } else if (newDelay) {
            alert('❌ Invalid delay.\n\nPlease enter a number between 50 and 2000 milliseconds.');
        }
    }

    // ========================================================================
    // ICON PROCESSING
    // ========================================================================

    /**
     * Fetch icon from LaMetric CDN using GM_xmlhttpRequest to bypass CORS
     * @param {string} iconId - Icon ID
     * @param {string} extension - File extension (.png or .gif)
     */
    function fetchIcon(iconId, extension = '.png') {
        return new Promise((resolve, reject) => {
            const iconUrl = `https://developer.lametric.com/content/apps/icon_thumbs/${iconId}${extension}`;
            
            GM_xmlhttpRequest({
                method: 'GET',
                url: iconUrl,
                responseType: extension === '.gif' ? 'arraybuffer' : 'blob',
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(response.response);
                    } else {
                        reject(new Error(`Failed to fetch icon: HTTP ${response.status}`));
                    }
                },
                onerror: function(error) {
                    reject(new Error('Network error fetching icon'));
                },
                ontimeout: function() {
                    reject(new Error('Timeout fetching icon'));
                }
            });
        });
    }

    /**
     * Convert PNG blob to RGB888 array for AWTRIX
     * LaMetric icons are 8x8, we keep them 8x8 and position at x=12 on AWTRIX
     */
    function processIcon(blob) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            
            img.onload = () => {
                try {
                    // Create canvas for 8x8 icon
                    const canvas = document.createElement('canvas');
                    canvas.width = CONFIG.AWTRIX_ICON_WIDTH;
                    canvas.height = CONFIG.AWTRIX_ICON_HEIGHT;
                    const ctx = canvas.getContext('2d');
                    
                    // Draw image scaled to 8x8
                    ctx.drawImage(img, 0, 0, CONFIG.AWTRIX_ICON_WIDTH, CONFIG.AWTRIX_ICON_HEIGHT);
                    
                    // Extract pixel data
                    const imageData = ctx.getImageData(0, 0, CONFIG.AWTRIX_ICON_WIDTH, CONFIG.AWTRIX_ICON_HEIGHT);
                    const pixels = imageData.data; // RGBA array
                    
                    // Convert to RGB888 (skip alpha channel)
                    const rgbArray = [];
                    for (let i = 0; i < pixels.length; i += 4) {
                        rgbArray.push(pixels[i]);     // R
                        rgbArray.push(pixels[i + 1]); // G
                        rgbArray.push(pixels[i + 2]); // B
                    }
                    
                    resolve(rgbArray);
                } catch (error) {
                    reject(new Error('Failed to process icon: ' + error.message));
                }
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load icon image'));
            };
            
            // Create blob URL for canvas
            img.src = URL.createObjectURL(blob);
        });
    }

    /**
     * Extract frames from animated GIF using omggif library
     * @param {ArrayBuffer} gifData - GIF file data
     * @returns {Promise<Array>} Array of frame objects with rgbArray
     */
    async function extractGifFrames(gifData) {
        try {
            // Convert ArrayBuffer to Uint8Array for omggif
            const uint8Array = new Uint8Array(gifData);
            
            // Parse GIF with omggif (loaded via @require)
            const reader = new GifReader(uint8Array);
            const numFrames = reader.numFrames();
            const width = reader.width;
            const height = reader.height;
            
            console.log(`GIF info: ${width}x${height}, ${numFrames} frames`);
            
            const processedFrames = [];
            
            // Create canvas for scaling
            const canvas = document.createElement('canvas');
            canvas.width = CONFIG.AWTRIX_ICON_WIDTH;
            canvas.height = CONFIG.AWTRIX_ICON_HEIGHT;
            const ctx = canvas.getContext('2d');
            
            // Process each frame
            for (let frameIndex = 0; frameIndex < numFrames; frameIndex++) {
                // Get frame info
                const frameInfo = reader.frameInfo(frameIndex);
                
                // Decode frame pixels (RGBA)
                const framePixels = new Uint8Array(width * height * 4);
                reader.decodeAndBlitFrameRGBA(frameIndex, framePixels);
                
                // Create temporary canvas at original size
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                const tempCtx = tempCanvas.getContext('2d');
                
                // Put pixel data into canvas
                const imageData = tempCtx.createImageData(width, height);
                imageData.data.set(framePixels);
                tempCtx.putImageData(imageData, 0, 0);
                
                // Scale to 8x8
                ctx.clearRect(0, 0, CONFIG.AWTRIX_ICON_WIDTH, CONFIG.AWTRIX_ICON_HEIGHT);
                ctx.drawImage(tempCanvas, 0, 0, CONFIG.AWTRIX_ICON_WIDTH, CONFIG.AWTRIX_ICON_HEIGHT);
                
                // Extract RGB data (skip alpha)
                const scaledImageData = ctx.getImageData(0, 0, CONFIG.AWTRIX_ICON_WIDTH, CONFIG.AWTRIX_ICON_HEIGHT);
                const pixels = scaledImageData.data;
                
                const rgbArray = [];
                for (let i = 0; i < pixels.length; i += 4) {
                    rgbArray.push(pixels[i]);     // R
                    rgbArray.push(pixels[i + 1]); // G
                    rgbArray.push(pixels[i + 2]); // B
                }
                
                processedFrames.push({
                    rgbArray: rgbArray,
                    delay: (frameInfo.delay || 10) * 10 // GIF delay is in 1/100th seconds, convert to ms
                });
            }
            
            console.log(`Extracted ${processedFrames.length} frames`);
            return processedFrames;
        } catch (error) {
            console.error('Failed to parse GIF:', error);
            throw new Error('Failed to extract GIF frames: ' + error.message);
        }
    }

    /**
     * Sleep utility for animation delays
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Create AWTRIX JSON payload with drawing instructions
     * Uses individual pixel drawing (dp) instead of bitmap (db) for better compatibility
     * @param {Array} rgbArray - RGB888 pixel data
     * @param {boolean} stack - If false, immediately replace current notification (default: true)
     */
    function createAwtrixPayload(rgbArray, stack = true) {
        const drawCommands = [];
        
        // Convert RGB888 array to individual pixel draw commands
        // rgbArray has 192 values (8×8 pixels × 3 bytes RGB)
        for (let y = 0; y < CONFIG.AWTRIX_ICON_HEIGHT; y++) {
            for (let x = 0; x < CONFIG.AWTRIX_ICON_WIDTH; x++) {
                const pixelIndex = (y * CONFIG.AWTRIX_ICON_WIDTH + x) * 3;
                const r = rgbArray[pixelIndex];
                const g = rgbArray[pixelIndex + 1];
                const b = rgbArray[pixelIndex + 2];
                
                // Convert RGB to hex color
                const color = '#' + 
                    r.toString(16).padStart(2, '0') +
                    g.toString(16).padStart(2, '0') +
                    b.toString(16).padStart(2, '0');
                
                // Draw pixel at position (x + offset, y) to center on 32x8 display
                drawCommands.push({
                    dp: [x + CONFIG.ICON_X_OFFSET, y, color]
                });
            }
        }
        
        return {
            draw: drawCommands,
            duration: CONFIG.DEFAULT_DURATION,
            stack: stack
        };
    }

    // ========================================================================
    // AWTRIX COMMUNICATION
    // ========================================================================

    /**
     * Clear existing AWTRIX notification
     */
    function clearAwtrixNotification() {
        return new Promise((resolve, reject) => {
            const ip = GM_getValue('awtrix_ip');
            if (!ip) {
                reject(new Error('No AWTRIX IP configured'));
                return;
            }

            const url = `http://${ip}/api/notify`;

            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify({}), // Empty payload clears notification
                timeout: 3000,
                onload: function(response) {
                    console.log('🧹 Cleared existing notification');
                    resolve(response);
                },
                onerror: function(error) {
                    // Don't fail if clear fails, just log it
                    console.warn('⚠️ Failed to clear notification:', error);
                    resolve();
                },
                ontimeout: function() {
                    console.warn('⚠️ Clear notification timeout');
                    resolve();
                }
            });
        });
    }

    /**
     * Send icon to AWTRIX via HTTP POST to /api/notify
     */
    function sendToAwtrix(payload) {
        return new Promise((resolve, reject) => {
            const ip = GM_getValue('awtrix_ip');
            if (!ip) {
                reject(new Error('No AWTRIX IP configured'));
                return;
            }

            const url = `http://${ip}/api/notify`;
            const jsonPayload = JSON.stringify(payload);

            console.log('Sending to AWTRIX:', url);
            console.log('Payload:', jsonPayload);

            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: jsonPayload,
                timeout: 5000,
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        console.log('✅ Icon sent to AWTRIX successfully');
                        resolve(response);
                    } else {
                        console.error('❌ AWTRIX error:', response.status, response.responseText);
                        reject(new Error(`AWTRIX returned status ${response.status}`));
                    }
                },
                onerror: function(error) {
                    console.error('❌ Failed to reach AWTRIX:', error);
                    reject(new Error('Network error sending to AWTRIX'));
                },
                ontimeout: function() {
                    console.error('❌ AWTRIX request timeout');
                    reject(new Error('Timeout sending to AWTRIX'));
                }
            });
        });
    }

    /**
     * Copy JSON payload to clipboard
     */
    function exportToClipboard(payload) {
        const jsonString = JSON.stringify(payload, null, 2);
        GM_setClipboard(jsonString, 'text');
        console.log('📋 Copied to clipboard:', jsonString);
    }

    // ========================================================================
    // UI INJECTION
    // ========================================================================

    /**
     * Create and inject buttons for an icon element
     */
    function injectButtons(iconElement) {
        // Check if buttons already injected
        if (iconElement.querySelector('.awtrix-buttons')) {
            return;
        }

        const iconId = iconElement.getAttribute('data-id');
        const iconName = iconElement.getAttribute('data-name');
        
        if (!iconId) return;

        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'awtrix-buttons';
        buttonContainer.style.cssText = `
            display: flex;
            gap: 4px;
            justify-content: center;
            margin-top: 4px;
        `;

        // Create "Send to AWTRIX" button
        const sendButton = document.createElement('button');
        sendButton.textContent = '📡';
        sendButton.title = 'Send to AWTRIX';
        sendButton.style.cssText = CONFIG.BUTTON_STYLE + `background-color: ${CONFIG.SEND_BUTTON_COLOR};`;
        sendButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await handleSendClick(iconId, iconName, sendButton);
        };

        // Create "Export Icon" button
        const exportButton = document.createElement('button');
        exportButton.textContent = '📋';
        exportButton.title = 'Copy JSON payload to clipboard';
        exportButton.style.cssText = CONFIG.BUTTON_STYLE + `background-color: ${CONFIG.EXPORT_BUTTON_COLOR};`;
        exportButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await handleExportClick(iconId, iconName, exportButton);
        };

        // Add hover effects
        [sendButton, exportButton].forEach(btn => {
            btn.onmouseenter = () => btn.style.opacity = '0.8';
            btn.onmouseleave = () => btn.style.opacity = '1';
        });

        buttonContainer.appendChild(sendButton);
        buttonContainer.appendChild(exportButton);

        // Insert buttons after the .img-box, before .subtitle
        const imgBox = iconElement.querySelector('.img-box');
        const subtitle = iconElement.querySelector('.subtitle');
        
        if (imgBox && subtitle) {
            iconElement.insertBefore(buttonContainer, subtitle);
        } else if (imgBox) {
            imgBox.after(buttonContainer);
        }
    }

    // Track animation loops per button
    const animationLoops = new Map();

    /**
     * Handle "Send to AWTRIX" button click
     */
    async function handleSendClick(iconId, iconName, button) {
        const originalText = button.textContent;
        
        try {
            // Check if IP is configured
            const ip = GM_getValue('awtrix_ip');
            if (!ip) {
                alert('⚙️ Please configure AWTRIX IP first!\n\nGo to Tampermonkey menu → "Set AWTRIX IP"');
                return;
            }

            // Check if this is an animated icon
            const iconElement = button.closest('.one');
            const isAnimated = iconElement && iconElement.getAttribute('data-type') === '1';

            if (isAnimated) {
                // Handle animated GIF with hover-loop
                button.textContent = '⏳ Loading...';
                button.disabled = true;

                console.log(`Fetching animated GIF ${iconId} (${iconName})...`);
                const gifData = await fetchIcon(iconId, '.gif');
                
                console.log('Extracting GIF frames...');
                const frames = await extractGifFrames(gifData);
                
                console.log(`Starting animation loop with ${frames.length} frames`);
                
                // Clear existing notification once at start
                await clearAwtrixNotification();
                
                // Start animation loop
                let frameIndex = 0;
                const frameDelay = GM_getValue('frame_delay', 200);
                
                const loopId = setInterval(async () => {
                    // Send current frame with stack:false for instant replacement
                    const payload = createAwtrixPayload(frames[frameIndex].rgbArray, false);
                    await sendToAwtrix(payload);
                    
                    // Update button text
                    button.textContent = `🎬 ${frameIndex + 1}/${frames.length}`;
                    
                    // Next frame (loop)
                    frameIndex = (frameIndex + 1) % frames.length;
                }, frameDelay);
                
                // Store loop ID
                animationLoops.set(button, loopId);
                
                // Re-enable button
                button.disabled = false;
                
                // Stop animation when mouse leaves
                button.onmouseleave = () => {
                    const loop = animationLoops.get(button);
                    if (loop) {
                        clearInterval(loop);
                        animationLoops.delete(button);
                        button.textContent = originalText;
                        console.log('🛑 Animation stopped (mouse left button)');
                    }
                };
                
            } else {
                // Handle static PNG
                button.textContent = '⏳ Sending...';
                button.disabled = true;

                console.log(`Fetching icon ${iconId} (${iconName})...`);
                const blob = await fetchIcon(iconId, '.png');
                
                console.log('Processing icon...');
                const rgbArray = await processIcon(blob);
                
                console.log('Creating payload...');
                const payload = createAwtrixPayload(rgbArray, false); // stack: false for instant display
                
                console.log('Sending to AWTRIX...');
                await sendToAwtrix(payload);

                // Success feedback
                button.textContent = '✅ Sent!';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.disabled = false;
                }, 2000);
            }

        } catch (error) {
            console.error('Error sending icon:', error);
            button.textContent = '❌ Failed';
            alert(`Failed to send icon to AWTRIX:\n\n${error.message}\n\nCheck console for details.`);
            
            setTimeout(() => {
                button.textContent = originalText;
                button.disabled = false;
            }, 2000);
        }
    }

    /**
     * Handle "Export Icon" button click
     */
    async function handleExportClick(iconId, iconName, button) {
        const originalText = button.textContent;
        
        try {
            // Update button state
            button.textContent = '⏳ Processing...';
            button.disabled = true;

            // Fetch and process icon
            console.log(`Fetching icon ${iconId} (${iconName}) for export...`);
            const blob = await fetchIcon(iconId);
            
            console.log('Processing icon...');
            const rgbArray = await processIcon(blob);
            
            console.log('Creating payload...');
            const payload = createAwtrixPayload(rgbArray, false); // stack: false for instant display
            
            console.log('Copying to clipboard...');
            exportToClipboard(payload);

            // Success feedback
            button.textContent = '✅ Copied!';
            
            // Show helpful message
            const ip = GM_getValue('awtrix_ip', 'YOUR_AWTRIX_IP');
            alert(`📋 JSON payload copied to clipboard!\n\nYou can now:\n\n1. Test with curl:\ncurl -X POST http://${ip}/api/notify \\\n  -H "Content-Type: application/json" \\\n  -d '<paste>'\n\n2. Use in Home Assistant automations\n\n3. Debug the payload structure`);
            
            setTimeout(() => {
                button.textContent = originalText;
                button.disabled = false;
            }, 2000);

        } catch (error) {
            console.error('Error exporting icon:', error);
            button.textContent = '❌ Failed';
            alert(`Failed to export icon:\n\n${error.message}\n\nCheck console for details.`);
            
            setTimeout(() => {
                button.textContent = originalText;
                button.disabled = false;
            }, 2000);
        }
    }

    /**
     * Scan page for icon elements and inject buttons
     */
    function scanAndInject() {
        const iconElements = document.querySelectorAll('.one[data-id]');
        iconElements.forEach(injectButtons);
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    /**
     * Initialize userscript
     */
    function init() {
        console.log('🚀 LaMetric to AWTRIX userscript loaded');

        // Initial scan
        scanAndInject();

        // Watch for dynamically loaded icons (LaMetric uses AJAX/lazy loading)
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element node
                        if (node.classList && node.classList.contains('one') && node.hasAttribute('data-id')) {
                            injectButtons(node);
                        }
                        // Also check children
                        if (node.querySelectorAll) {
                            node.querySelectorAll('.one[data-id]').forEach(injectButtons);
                        }
                    }
                });
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log('👀 Watching for new icons...');
    }

    // Wait for page to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
