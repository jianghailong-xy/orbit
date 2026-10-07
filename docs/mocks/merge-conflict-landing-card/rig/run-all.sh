#!/bin/bash
# Renders every frame for docs/mocks/merge-conflict-landing-card. usage: run-all.sh [frame...]
cd "$(dirname "$0")" && mkdir -p out
ROUTE="/sessions/2zQeDGWFFAgN2112jNEkH?project=2zQeDGWFFAgN2112jNEkG"
RD="!!document.querySelector('.session-row') && document.querySelectorAll('.workspace-view .chat-msg').length >= 2"
declare -A SCEN SCRIPT EXTRA
SCEN[now-desktop]=now;            SCRIPT[now-desktop]=-
SCEN[after-fixing]=fixing;        SCRIPT[after-fixing]=frames/after-fixing.js
SCEN[dlg-details]=fixing;         SCRIPT[dlg-details]=frames/dlg-details.js
SCEN[crop-triage]=fixing;         SCRIPT[crop-triage]=frames/crop-triage.js
SCEN[crop-fixing]=fixing;         SCRIPT[crop-fixing]=frames/crop-fixing.js
SCEN[after-escalated]=escalated;  SCRIPT[after-escalated]=frames/after-escalated.js
SCEN[dlg-sendback]=escalated;     SCRIPT[dlg-sendback]=frames/dlg-sendback.js
SCEN[crop-yours]=escalated;       SCRIPT[crop-yours]=frames/crop-yours.js
SCEN[after-relanding]=relanding;  SCRIPT[after-relanding]=frames/after-relanding.js; EXTRA[after-relanding]=" && !!document.querySelector('.session-project-page-landing')"
SCEN[crop-relanding]=relanding;   SCRIPT[crop-relanding]=frames/crop-relanding.js;   EXTRA[crop-relanding]=" && !!document.querySelector('.session-project-page-landing')"
SCEN[after-landed]=landed;        SCRIPT[after-landed]=frames/after-landed.js
SCEN[crop-landed]=landed;         SCRIPT[crop-landed]=frames/crop-landed.js
SCEN[crop-landing1]=relanding; SCRIPT[crop-landing1]=frames/crop-landing1.js; EXTRA[crop-landing1]=" && !!document.querySelector('.session-project-page-landing')"
SCEN[crop-merge]=landed;        SCRIPT[crop-merge]=frames/crop-merge.js
ALL="now-desktop after-fixing dlg-details crop-triage crop-fixing after-escalated dlg-sendback crop-yours after-relanding crop-relanding after-landed crop-landed crop-landing1 crop-merge"
for f in ${@:-$ALL}; do
  curl -s "http://127.0.0.1:3997/api/__scenario?name=${SCEN[$f]}" >/dev/null
  READY="$RD${EXTRA[$f]}" timeout 150 node shot.mjs "$ROUTE" "out/$f.png" 1440 900 "${SCRIPT[$f]}" 2>&1 | grep -aE "SCRIPT EXC|READY TIMEOUT|wrote|^EXC" | sed "s/^/[$f] /"
done
# Phone frames (390 x 844): the conversation as it is today, and the project page with the card.
PR="!!document.querySelector('.session-project-page-card') && !!document.querySelector('.chat-msg')"
if [ -z "$*" ] || [[ " $* " == *" phone "* ]]; then
  curl -s "http://127.0.0.1:3997/api/__scenario?name=now" >/dev/null
  READY="$PR" timeout 150 node shot.mjs "$ROUTE" out/phone-now.png 390 844 - mobile 2>&1 | grep -aE "SCRIPT EXC|READY TIMEOUT|wrote" | sed "s/^/[phone-now] /"
  curl -s "http://127.0.0.1:3997/api/__scenario?name=fixing" >/dev/null
  READY="$PR" timeout 150 node shot.mjs "$ROUTE" out/phone-fixing.png 390 844 frames/phone-fixing.js mobile 2>&1 | grep -aE "SCRIPT EXC|READY TIMEOUT|wrote" | sed "s/^/[phone-fixing] /"
  curl -s "http://127.0.0.1:3997/api/__scenario?name=escalated" >/dev/null
  READY="$PR" timeout 150 node shot.mjs "$ROUTE" out/phone-yours.png 390 844 frames/phone-yours.js mobile 2>&1 | grep -aE "SCRIPT EXC|READY TIMEOUT|wrote" | sed "s/^/[phone-yours] /"
fi
