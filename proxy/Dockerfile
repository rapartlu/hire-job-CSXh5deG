FROM mitmproxy/mitmproxy:10

COPY addon.py /addon.py

ENV DB_PATH=/data/captures.db

EXPOSE 8080

# --set confdir=/data/mitmproxy makes mitmproxy write its CA cert (and all
# config) directly into the shared data volume, where the dashboard serves it
# from. This is deterministic regardless of which user the container runs as,
# and the CA stays stable across restarts so the customer only imports it once.
CMD ["mitmdump", \
     "--listen-host", "0.0.0.0", \
     "--listen-port", "8080", \
     "--set", "confdir=/data/mitmproxy", \
     "-s", "/addon.py"]
