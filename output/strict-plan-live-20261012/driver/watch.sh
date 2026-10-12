#!/bin/bash
# usage: watch.sh <name> <run> <max-seconds> ; returns when the request log has been quiet for 120s or the limit passes
R=D:/dsh-test/output/strict-plan-live-20261012/$1; t=0; last=-1; quiet=0
while [ $t -lt $3 ]; do sleep 20; t=$((t+20)); n=$(wc -l < $R/requests.jsonl 2>/dev/null || echo 0)
  if [ "$n" = "$last" ] && [ "$n" != 0 ]; then quiet=$((quiet+20)); else quiet=0; fi; last=$n
  [ $quiet -ge 120 ] && break; grep -q '"status": "stopped"' $R/$2-state.json && break; done
echo "elapsed=$t requests=$last state=$(grep -o '"status": "[a-z]*"' $R/$2-state.json) reason=$(grep -o '"reason": "[^"]*"' $R/$2-state.json)"
for c in DELIVERY_PLAN_REQUIRED GOAL_PLAN_UNBOUND GOAL_DELIVERY_BRIDGE_UNAVAILABLE GOAL_BACKGROUND_PENDING DELIVERY_SOURCE_UNAVAILABLE DELIVERY_ENVIRONMENT_UNAVAILABLE RECOVERY_PATH_DENIED plan_register goal_plan_bind; do echo "$c=$(grep -o "$c" $R/requests.jsonl | wc -l)"; done
ls $R/workspace; ls $R/home/sessions 2>/dev/null | head; grep -c "failed to import\|Unhandled\|TypeError" $R/$2-host.log
