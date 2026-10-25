#!/usr/bin/env bash
# probes-final.sh: the measurements the README quotes, re-taken on the formal trees (REF_DIR=v1/ref, DEL_DIR=v1/del) with
# probe-both.sh; outputs in probe/final/<name>-{ref,del}.txt. Run alone (each probe serves both trees in its own namespace).
set -u
T=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ
export REF_DIR=$T/v1/ref DEL_DIR=$T/v1/del
P=$T/probe; O=$P/final; mkdir -p $O
run() { local name=$1 scenario=$2 selectors=$3; shift 3
  ( cd $O && env "$@" $T/scripts/probe-both.sh $P/$scenario "$selectors" > /dev/null 2>&1; mv probe-ref.txt $name-ref.txt; mv probe-del.txt $name-del.txt )
  echo "$name done"; }
# The held press's menu on a phone: its box and its min-width (README 开发中 1).
run press-menu press-menu.mjs '[".session-row-menu", ".ant-dropdown.session-row-menu, .orbit-menu.session-press-menu"]' SIZE=phone
# The model menu above its trigger: the rows' vertical positions, the values and the arrows (纵向取整).
run model-menu model-menu.mjs '[".scope-menu-row", ".scope-menu-value", ".ant-dropdown-menu-title-content, .orbit-menu-label", ".ant-dropdown-menu-submenu-arrow, .orbit-menu-submenu-icon"]'
# The scope menu's Filter by Tag level, Chromium and WebKit desktop (结尾对齐列表的小数边缘).
run scope-tags-chromium scope-tags.mjs '[".ant-dropdown-menu-sub, .orbit-menu[data-nested]", ".ant-dropdown-menu-root, .session-scope-popup"]'
run scope-tags-webkit scope-tags.mjs '[".ant-dropdown-menu-sub, .orbit-menu[data-nested]", ".ant-dropdown-menu-root, .session-scope-popup"]' BROWSER=webkit
# A tapped trigger's hover in Chromium's phone emulation (触屏模拟留下的悬停).
run tap-hover tap-hover2.mjs '[]' SIZE=phone
# The shell prompt's line in WebKit (16px 按钮的行高).
run shell-webkit shell.mjs '[".composer-attach-btn", ".composer-attach-btn > *"]' BROWSER=webkit
# The scope menu's level on a WebKit phone after a tag is tapped (参照留下的子菜单).
run scope-tap-webkit-phone scope-tap.mjs '[]' BROWSER=webkit SIZE=phone
