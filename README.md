# IdleHub

Painel para jogos idle de navegador: várias contas por jogo numa janela só,
watchdog que recarrega conta travada, contas "dormindo" para liberar memória e
alertas lendo valores da página. Tudo roda no PC de cada pessoa; não há servidor.

Inclui o **Painel** (o [IdleLive](idlelive/README.md)): contas da Twitch e da Kick
juntando pontos do canal nas lives dos parceiros, votos e histórico. As contas dos
jogos continuam rodando enquanto você usa o Painel.

## Rodar no seu PC (desenvolvimento)

```powershell
npm install
npm start
```

Antes de enviar mudanças: `npm run check` (sintaxe), `npm test` (testes do app) e
`npm run test:idlelive` (testes do Painel). O GitHub Actions roda os três a cada push.
Regras do projeto: [AGENTS.md](AGENTS.md) · visual: [DESIGN.md](DESIGN.md) · mudanças: [CHANGELOG.md](CHANGELOG.md).

## Gerar o instalador para os amigos

```powershell
npm run dist
```

Sai em `dist/IdleHub Setup <versão>.exe`. Sem certificado de assinatura, o
Windows mostra "O Windows protegeu o computador" na primeira vez: é só clicar em
**Mais informações → Executar assim mesmo**.

### Publicar uma versão nova (atualização automática)

O app de cada amigo verifica os releases de `RicardooFilho/IdleHub` ao abrir e a
cada 6 horas, baixa a versão nova e instala ao fechar.

1. Aumente `version` no `package.json` (ex.: `0.1.0` → `0.2.0`).
2. Rode, com um token do GitHub:
   ```powershell
   $env:GH_TOKEN = (gh auth token); npm run release
   ```
3. Publique o rascunho de release que aparece em GitHub → Releases.

## Como funciona

| Parte | Onde |
|---|---|
| Janela, bandeja, notificações, IPC | `src/main/main.js` |
| Contas (uma sessão isolada por conta), watchdog, alertas | `src/main/accounts.js` |
| Perfis prontos dos jogos | `src/main/games.js` |
| Avisos fora do PC (Discord; cofre de segredos criptografado) | `src/main/remote.js` |
| Configuração local (`%APPDATA%/IdleHub/config.json`) | `src/main/config.js` |
| "Sempre visível" + limitador de FPS injetado no jogo | `src/preload/game.js` |
| Interface (Web Awesome, Font Awesome e Montserrat vêm junto, servidos por `idlehub://`) | `src/renderer/` |
| Testes (`node:test`) | `test/` |
| Inicia, vigia e reinicia o IdleLive; importa dados do IdleLive avulso | `src/main/idlelive.js` |
| Página do IdleLive dentro da janela | `src/main/panel.js` |
| Atalhos de teclado (lidos também dentro das contas e do Painel) | `src/main/shortcuts.js` |
| O IdleLive em si (servidor Node + painel web) | `idlelive/` (veja `idlelive/AGENTS.md`) |

- **Logins:** cada conta tem sua própria pasta de cookies (`persist:acc-<jogo>-<conta>`).
  O painel não guarda senhas; você entra uma vez em cada conta e o login fica salvo.
- **Watchdog:** a cada N segundos verifica cada conta. Recarrega se parar de responder,
  ficar em branco, cair, ficar carregando demais ou passar do limite de memória
  (no máximo 1 recarga por minuto por conta). Avisa quando a conta sai do login.
- **Alertas:** "Texto" (palavra aparece na página) ou "Número" (seletor CSS e/ou regex + condição).
  Use **🔍 Inspecionar** numa conta expandida para achar o seletor.
- **Atalhos:** com a janela em foco, **Ctrl+1…9** abre a conta 1 a 9, **Ctrl+Tab** / **Ctrl+Shift+Tab** passam para a próxima/anterior, **F5** recarrega a conta aberta e **Ctrl+M** silencia tudo.
  A lista também está em Configurações.
- **Memória:** contas escondidas rodam com FPS limitado (só a animação; os temporizadores do
  jogo seguem em 100%); contas dormindo não gastam nada.

## Avisos no celular

- **Configurações → Avisos no celular → Discord:** cole o link de um webhook (no Discord:
  Configurações do canal → Integrações → Webhooks → Copiar URL do webhook) e use **Enviar teste**.
  Os avisos do Windows (conta caiu, alerta, sem internet) passam a ir também para o canal.
- Não existe servidor nosso: o IdleHub fala direto com o Discord.
- O link do webhook (e, no futuro, tokens de outros canais) fica em `%APPDATA%/IdleHub/secrets.json`,
  **criptografado** com o `safeStorage` do Electron (no Windows, só a sua conta do Windows consegue abrir).
  Nunca vai para o `config.json` nem para o git. Trocar de PC ou de usuário do Windows exige colar o link de novo.
  Se o Windows não oferecer criptografia, o IdleHub não salva o link.
- Para adicionar um canal novo (ex.: Telegram), veja a lista `CHANNELS` e a explicação no topo de `src/main/remote.js`.

## Painel (IdleLive)

- Roda num processo separado (`utilityProcess`), na porta **3000**, com
  `IDLELIVE_EMBEDDED=1`: a atualização própria e o "Iniciar com o Windows" do IdleLive
  ficam desligados, porque o IdleHub cuida disso. "Reiniciar servidor" funciona.
- Se ele cair, o IdleHub abre de novo sozinho. Os jogos não são afetados.
- Os dados (tokens da Twitch/Kick, canais, histórico) ficam em `%APPDATA%/IdleHub/idlelive`,
  **nunca** na pasta do projeto nem no git.
- **Porta 3000 ocupada** = IdleLive avulso (`iniciar.bat`) aberto. O IdleHub espera e
  assume quando ele fechar. Os dois juntos com as mesmas contas fariam a Twitch pedir
  para vincular de novo (o refresh token só vale uma vez).
- **Importar do IdleLive avulso:** Configurações → Importar dados do IdleLive.
- Testes do IdleLive: `npm run test:idlelive`. Para testar o app sem fechar o IdleLive avulso:
  `$env:IDLEHUB_IDLELIVE_PORT='3055'` (e `IDLEHUB_DATA` com uma pasta de teste).

## Testar sem mexer na sua config

```powershell
$env:IDLEHUB_DATA="$env:TEMP\idlehub-teste"; $env:IDLEHUB_DEBUG='1'; npm start
```
