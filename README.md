# 🎯 Mission Control — Autonome KI-Agentur Infrastruktur

Zentrale Deployment-Konfigurationen für die OpenClaw-basierte AI-Agentur Infrastruktur.

## 📊 Architektur

```
MacBook Pro (Claude Code) ──→ Cloudflare Zero Trust Tunnel
                                    ↓
                        ┌───────────┴───────────┐
                        ↓                       ↓
                   VPS-L (Production)    VPS-M (Staging)
                   87.106.187.170         217.154.156.46
```

## 📦 Komponenten

### VPS-L (Production)
- PostgreSQL 16
- OpenClaw Dashboard
- OpenClaw Agent (Port 18789)
- Nginx Proxy Manager

### VPS-M (Staging & Monitoring)
- Staging Dashboard
- Uptime Kuma (Port 3001)
- Dozzle Logs (Port 9999)

## 🚀 Deployment

```bash
docker compose -f vps-l/docker-compose.yml up -d
docker compose -f vps-m/docker-compose.yml up -d
```

## 📝 Environment

Kopiere `.env.example` zu `.env` und fülle Secrets ein.

---
**Setup-Datum:** 2026-03-17
