# IdleHub

Painel para jogos idle de navegador: várias contas por jogo numa janela só,
watchdog que recarrega conta travada, contas "dormindo" para liberar memória e
alertas lendo valores da página. Tudo roda no PC de cada pessoa; não há servidor.

## Rodar no seu PC (desenvolvimento)

```powershell
npm install
npm start
```

## Gerar o instalador para os amigos

```powershell
npm run dist
```

Sai em `dist/IdleHub Setup <versão>.exe`. Sem certificado de assinatura, o
Windows mostra "O Windows protegeu o computador" na primeira vez: é só clicar em
**Mais informações → Executar assim mesmo**.

### Atualização automática (opcional)

O código está em `RicardooFilho/IdleHub`. Para os amigos receberem atualizações
sozinhos, os releases precisam ser públicos (repositório público, ou um segundo
repositório público só para os instaladores).

1. Adicione em `package.json`, dentro de `"build"`:
   ```json
   "publish": [{ "provider": "github", "owner": "RicardooFilho", "repo": "IdleHub" }]
   ```
2. Aumente `version` no `package.json` e rode `npx electron-builder --win --publish always`
   com a variável `GH_TOKEN` definida. O app de todo mundo baixa a versão nova sozinho.

## Como funciona

| Parte | Onde |
|---|---|
| Janela, bandeja, notificações, IPC | `src/main/main.js` |
| Contas (uma sessão isolada por conta), watchdog, alertas | `src/main/accounts.js` |
| Perfis prontos dos jogos | `src/main/games.js` |
| Configuração local (`%APPDATA%/IdleHub/config.json`) | `src/main/config.js` |
| "Sempre visível" + limitador de FPS injetado no jogo | `src/preload/game.js` |
| Interface | `src/renderer/` |

- **Logins:** cada conta tem sua própria pasta de cookies (`persist:acc-<jogo>-<conta>`).
  O painel não guarda senhas; você entra uma vez em cada conta e o login fica salvo.
- **Watchdog:** a cada N segundos verifica cada conta. Recarrega se parar de responder,
  ficar em branco, cair, ficar carregando demais ou passar do limite de memória
  (no máximo 1 recarga por minuto por conta). Avisa quando a conta sai do login.
- **Alertas:** "Texto" (palavra aparece na página) ou "Número" (seletor CSS e/ou regex + condição).
  Use **🔍 Inspecionar** numa conta expandida para achar o seletor.
- **Memória:** contas escondidas rodam com FPS baixo; contas dormindo não gastam nada.

## Testar sem mexer na sua config

```powershell
$env:IDLEHUB_DATA="$env:TEMP\idlehub-teste"; $env:IDLEHUB_DEBUG='1'; npm start
```
