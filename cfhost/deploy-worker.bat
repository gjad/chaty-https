@echo off
REM Bump the version (worker APP_VERSION + embed_widget\emloader.js DEFAULT_VERSION), then deploy the chatboxy-api Worker
REM (e.g. after editing vars such as ALLOWED_ORIGINS in worker\wrangler.jsonc), the client-agent app
REM (build + wrangler pages deploy to the chatboxy-agent Pages project) and the embed widget
REM (build + wrangler pages deploy to the chatboxy-embed Pages project).
REM Usage: deploy-worker.bat [version]   (default: current version + 1)
setlocal
set "ROOT=%~dp0"

call node "%ROOT%scripts\bump-version.mjs" %1 || exit /b 1

cd /d "%ROOT%worker" || exit /b 1

if not exist node_modules (
  call npm install || exit /b 1
)

call npm run typecheck || exit /b 1
call npx wrangler deploy || exit /b 1

echo Worker deployed.

cd /d "%ROOT%client-agent" || exit /b 1

if not exist node_modules (
  call npm install || exit /b 1
)

call npm run deploy || exit /b 1

echo client-agent deployed.

cd /d "%ROOT%embed_widget" || exit /b 1

if not exist node_modules (
  call npm install || exit /b 1
)

call npm run build || exit /b 1
call "%ROOT%client-agent\node_modules\.bin\wrangler.cmd" pages deploy dist --project-name chatboxy-embed --branch main --commit-dirty=true || exit /b 1

echo embed widget deployed.
endlocal
