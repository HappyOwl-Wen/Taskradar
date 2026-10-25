// Run against a foreground scratch desktop instance started with TASKRADAR_WEBVIEW_DEBUG_PORT.
// Reports browser frame callbacks, not a monitor scan-out measurement. Does not change task data.
import { writeFileSync } from "node:fs";
import { connect } from "./cdp.mjs";

const [port, output] = process.argv.slice(2);
if (!port) throw new Error("usage: node refresh-rate.mjs <debugPort> [results.json]");
const c = await connect(port);
try {
  const context = await c.evaluate(`({url:location.href, viewport:[innerWidth,innerHeight], dpr:devicePixelRatio, visibility:document.visibilityState})`);
  if (context.visibility !== "visible") throw new Error("Show the test window before measuring.");
  const results = { context };
  for (const mode of ["scroll", "navigation"]) {
    results[mode] = await c.evaluate(`new Promise(resolve => {
      const main = document.querySelector('main');
      const originalScroll = main.scrollTop;
      const scrollRange = main.scrollHeight - main.clientHeight;
      const gaps = []; let start = 0, previous = 0, destination = 0;
      const paths = ['/tasks', '/', '/calendar', '/', '/tasks', '/'];
      function frame(time) {
        if (previous) gaps.push(time - previous); else start = time;
        previous = time;
        if (${JSON.stringify(mode)} === 'scroll') main.scrollTop = (Math.sin((time-start)/500)+1)*scrollRange/2;
        else if (destination < paths.length && time-start >= destination*800) {
          const link = [...document.querySelectorAll('.sidebar-entry')].find(link => link.getAttribute('href') === paths[destination]);
          link?.click(); destination++;
        }
        if (time-start < 4800) requestAnimationFrame(frame);
        else {
          main.scrollTop = originalScroll;
          gaps.sort((a,b)=>a-b);
          resolve({fps:gaps.length*1000/(time-start), frames:gaps.length, medianMs:gaps[Math.floor(gaps.length*.5)], p95Ms:gaps[Math.floor(gaps.length*.95)], maxMs:gaps.at(-1), scrollRange});
        }
      }
      requestAnimationFrame(frame);
    })`);
  }
  const json = JSON.stringify(results, null, 2);
  console.log(json);
  if (output) writeFileSync(output, `${json}\n`);
} finally { c.close(); }
