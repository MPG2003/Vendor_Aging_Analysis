import os

# Must exceed the longest AI API call (120s request timeout + buffer)
timeout = 180

# Gevent async workers — AI calls won't block other requests
worker_class = "gevent"
workers = 1
worker_connections = 100

# Bind
bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"

keepalive = 5

accesslog = "-"
errorlog = "-"
loglevel = "info"