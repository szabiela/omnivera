import { exec } from 'child_process';
import { writeFileSync } from 'fs';

export const POPUP_WIDTH = 500;
export const POPUP_HEIGHT = 750;

/**
 * Opens a branded popup window showing the Browserbase live view.
 * macOS only — uses AppleScript to control Safari window size.
 * In production this becomes a React modal in the mufi dashboard.
 */
export function openPopup(liveViewUrl: string, platformName: string): void {
  const popupHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Connect to ${platformName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; font-family: -apple-system, system-ui, sans-serif; overflow: hidden; }
  .header { height: 56px; background: #111; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid #222; }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .logo { width: 28px; height: 28px; background: #7c3aed; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 12px; }
  .title { color: #fff; font-size: 14px; font-weight: 600; }
  .subtitle { color: #666; font-size: 11px; }
  .status { display: flex; align-items: center; gap: 5px; color: #4ade80; font-size: 11px; }
  .dot { width: 5px; height: 5px; background: #4ade80; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  iframe { width: 100%; height: calc(100vh - 56px); border: none; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="logo">O</div>
      <div>
        <div class="title">Connect to ${platformName}</div>
        <div class="subtitle">Log in below — Omnivera never sees your password</div>
      </div>
    </div>
    <div class="status"><div class="dot"></div>Secure session</div>
  </div>
  <iframe src="${liveViewUrl}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;

  writeFileSync('/tmp/omnivera-connect.html', popupHtml);

  // Open Safari in a controlled popup window using AppleScript
  const script = `
    tell application "Safari"
      activate
      make new document with properties {URL:"file:///tmp/omnivera-connect.html"}
      delay 0.5
      set bounds of front window to {200, 100, ${200 + POPUP_WIDTH}, ${100 + POPUP_HEIGHT}}
    end tell
  `;
  exec(`osascript -e '${script}'`);
}

/**
 * Closes the Safari popup window and replaces content with "Connected!" message.
 */
export function closePopup(): void {
  const connectedHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Connected!</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; color: white; font-family: -apple-system, system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 12px; }
  .check { width: 48px; height: 48px; background: #4ade80; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-size: 24px; }
  h2 { font-size: 18px; font-weight: 600; }
  p { color: #888; font-size: 13px; }
</style>
</head>
<body>
  <div class="check">✓</div>
  <h2>Connected!</h2>
  <p>Extracting your data in the background...</p>
</body>
</html>`;

  writeFileSync('/tmp/omnivera-connect.html', connectedHtml);

  setTimeout(() => {
    const script = `
      tell application "Safari"
        close (every window whose name contains "Connect to" or name contains "Connected")
      end tell
    `;
    exec(`osascript -e '${script}'`);
  }, 2000);
}
