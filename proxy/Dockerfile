FROM mitmproxy/mitmproxy:10

COPY addon.py /addon.py

ENV DB_PATH=/data/captures.db

EXPOSE 8080

CMD ["mitmdump", \
     "--listen-host", "0.0.0.0", \
     "--listen-port", "8080", \
     "-s", "/addon.py"]
