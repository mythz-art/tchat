#!/bin/bash
# Render terminal transcripts as styled terminal-window PNGs (for README).
set -e
OUT=$1
TITLE=$2
BODY=$3   # HTML-escaped transcript with \n line breaks

cat > /home/z/my-project/.build/term-shot.html << EOF
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin:0; padding:32px; background:#0a0a0a; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .term { width: 780px; border-radius:12px; overflow:hidden; box-shadow:0 25px 60px rgba(0,0,0,.6); border:1px solid #27272a; }
  .bar { background:#18181b; padding:10px 14px; display:flex; gap:8px; align-items:center; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title { margin-left:10px; color:#71717a; font:13px 'SFMono-Regular',Menlo,monospace; }
  .scr { background:#09090b; padding:18px 20px; color:#e4e4e7; font:13.5px/1.55 'SFMono-Regular',Menlo,monospace; white-space:pre-wrap; word-break:break-all; min-height:280px; }
  .tm { color:#71717a; } .ok { color:#34d399; } .me { color:#a1a1aa; font-style:italic; } .you { color:#71717a; }
</style></head><body><div class="term">
<div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">${TITLE}</span></div>
<div class="scr">${BODY}</div>
</div></body></html>
EOF
agent-browser open "file:///home/z/my-project/.build/term-shot.html" > /dev/null 2>&1
sleep 1.5
agent-browser screenshot "$OUT" > /dev/null 2>&1
echo "saved $OUT"
