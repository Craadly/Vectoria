const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const config = require('../../config/env');

function nowNs() {
  return process.hrtime.bigint();
}

function msSince(startNs) {
  return Number((process.hrtime.bigint() - startNs) / 1_000_000n);
}

async function ensureTempDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function uniqueSvgName(prefix = 'vector_local') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`;
}

async function saveSvg(svgCode, method = 'unknown', prefix = 'vector_local') {
  await ensureTempDir(config.TEMP_DIR);
  const fileName = uniqueSvgName(prefix);
  const svgPath = path.join(config.TEMP_DIR, fileName);
  await fs.writeFile(svgPath, svgCode, 'utf8');
  return { svgCode, svgUrl: `/temp/${fileName}`, method };
}

function generateSimpleSVG(prompt) {
  const colors = ['#7c3aed', '#ec4899', '#06b6d4', '#10b981', '#f59e0b'];
  const randomColor = colors[Math.floor(Math.random() * colors.length)];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`;
  svg += `<rect width="200" height="200" fill="#ffffff"/>`;

  if (prompt.toLowerCase().includes('logo')) {
    svg += `<circle cx="100" cy="100" r="60" fill="${randomColor}" opacity="0.9"/>`;
    svg += `<circle cx="100" cy="100" r="40" fill="#ffffff"/>`;
    svg += `<circle cx="100" cy="100" r="20" fill="${randomColor}"/>`;
  } else if (prompt.toLowerCase().includes('character') || prompt.toLowerCase().includes('mascot')) {
    svg += `<circle cx="100" cy="80" r="30" fill="${randomColor}"/>`;
    svg += `<ellipse cx="100" cy="130" rx="25" ry="35" fill="${randomColor}"/>`;
    svg += `<circle cx="88" cy="75" r="5" fill="#ffffff"/>`;
    svg += `<circle cx="112" cy="75" r="5" fill="#ffffff"/>`;
    svg += `<path d="M 90 90 Q 100 95 110 90" stroke="#ffffff" stroke-width="2" fill="none"/>`;
  } else if (prompt.toLowerCase().includes('geometric')) {
    for (let i = 0; i < 5; i++) {
      const x = 40 + i * 30;
      const y = 40 + i * 25;
      const size = 30 - i * 4;
      svg += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${colors[i % colors.length]}" opacity="0.7" transform="rotate(${i * 15} 100 100)"/>`;
    }
  } else {
    svg += `<polygon points="100,40 140,120 60,120" fill="${randomColor}" opacity="0.8"/>`;
    svg += `<circle cx="100" cy="100" r="40" fill="none" stroke="${randomColor}" stroke-width="3"/>`;
    svg += `<rect x="70" y="70" width="60" height="60" fill="${randomColor}" opacity="0.3" transform="rotate(45 100 100)"/>`;
  }

  svg += `</svg>`;
  return svg;
}

module.exports = {
  nowNs,
  msSince,
  saveSvg,
  uniqueSvgName,
  generateSimpleSVG,
};