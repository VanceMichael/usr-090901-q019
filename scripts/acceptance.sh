#!/usr/bin/env bash
# 一键容器验收：
#   1. 构建镜像并启动 postgres + app（等待健康检查）
#   2. 阶段一：黑盒跑全部功能用例（含重启恢复的状态写入）
#   3. 真实重启 app 容器
#   4. 阶段二：校验重启后覆盖率快照与分页游标继续有效
# 用法：bash scripts/acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-recall-accept}"
COMPOSE=(docker compose)

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_healthy() {
  local service="$1" id status
  for _ in $(seq 1 90); do
    id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)"
    if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
      return 0
    fi
    sleep 1
  done
  echo "!! 服务 $service 未在 90s 内恢复健康（当前: $status）" >&2
  "${COMPOSE[@]}" logs "$service" >&2 || true
  return 1
}

echo "==> [1/5] 校验 scaffold 输入"
"${COMPOSE[@]}" run --rm --no-deps scaffold-check

echo "==> [2/5] 构建镜像"
"${COMPOSE[@]}" build app

echo "==> [3/5] 启动 postgres 与 app"
"${COMPOSE[@]}" up -d postgres app
wait_healthy postgres
wait_healthy app

echo "==> [4/5] 阶段一：黑盒验收（重复发布/迟到回执/豁免审核/覆盖率/混合批错误）"
"${COMPOSE[@]}" run --rm -e RESTART_PHASE=setup acceptance

echo "==> [5/5] 重启 app 容器并做重启恢复校验"
"${COMPOSE[@]}" restart app
wait_healthy app
"${COMPOSE[@]}" run --rm -e RESTART_PHASE=verify acceptance

echo "==> 验收通过：功能用例与重启恢复全部通过"
