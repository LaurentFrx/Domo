FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY atelier_bridge.py .

# La propriété de l'aspirateur (« est-ce nous qui l'avons allumé ? ») est
# persistée ici : un volume est OBLIGATOIRE, sinon un redémarrage du conteneur
# pendant un cycle laisse l'aspirateur allumé sans personne pour l'éteindre.
VOLUME ["/data"]

CMD ["python", "-u", "atelier_bridge.py"]
