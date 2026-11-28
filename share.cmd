@echo off
rem Mo StoryPrompt ra link cong khai (Cloudflare Quick Tunnel). Link hien tai nam o public-link.txt
cd /d "%~dp0"
call npx tsx scripts\share.ts
pause
