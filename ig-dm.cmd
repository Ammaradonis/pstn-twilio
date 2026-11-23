@echo off
rem Instagram DM outreach from @matboss_online on the Galaxy A20e (workers\email-finder\scripts\ig_dm.py).
rem   ig-dm preview --n 8     ig-dm report     ig-dm probe     ig-dm run --loop     ig-dm requeue held
"%~dp0workers\email-finder\.venv\Scripts\python.exe" "%~dp0workers\email-finder\scripts\ig_dm.py" %*
