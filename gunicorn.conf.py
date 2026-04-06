import os

# Worker timeout — must exceed the longest AI API call (OpenRouter can take 60-80s)
timeout = 120

# Use gevent async workers so one slow AI request doesn't block other users
worker_class = "gevent"
workers = 1
worker_connections = 100

# Bind
bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"

# Keep-alive
keepalive = 5

# Logging
accesslog = "-"
errorlog = "-"
loglevel = "info"