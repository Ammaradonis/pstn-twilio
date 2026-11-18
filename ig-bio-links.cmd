@echo off
rem Runs workers\email-finder\scripts\ig_bio_links.py from anywhere: ig-bio-links run --loop
"%~dp0workers\email-finder\.venv\Scripts\python.exe" "%~dp0workers\email-finder\scripts\ig_bio_links.py" %*
