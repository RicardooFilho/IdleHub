# Extensões e scripts de usuário nas contas: o que funciona

Resultado da tarefa **TAG-37** (parte de TAG-33, "Extensões e scripts de terceiros nas contas").
Pergunta: com o suporte parcial de extensões do Electron, o que da comunidade do PokeIdle roda? Vale
priorizar **extensões do Chrome** ou **scripts de usuário** (`.user.js`, estilo Tampermonkey)?

Testes feitos em 27/11/2026, com o Electron **45.5.0** (Chromium 156) do próprio IdleHub, no Windows 11.

## Resumo (para decidir)

- **Extensões primeiro.** O `session.extensions.loadExtension` do Electron 45 carregou **11 de 11**
  extensões da comunidade. A `/hunt for PokeIdle` (a que o jogo recomenda) roda sem nenhuma adaptação.
  Service worker (MV3), content scripts nos dois mundos (isolado e da página), `chrome.storage`,
  `chrome.alarms`, `chrome.scripting` e mensagens entre página, script e service worker funcionam.
- **Não funciona, e não vai funcionar só com o Electron:** ícone na barra, popup e janela de opções
  (o Electron não tem interface de extensões), `notifications`, `contextMenus`, `cookies`, `windows`,
  `downloads`, `commands`, `sidePanel`, `webNavigation` e `tabs.create`. Uma extensão que depende
  disso quebra: a **PokeIdle Piloto** cai no service worker (`chrome.notifications.onClosed` não existe).
- O complemento **`electron-chrome-extensions`** (MIT) cobre quase tudo isso (testado: `notifications`,
  `contextMenus`, `cookies`, `windows`, `tabs.create`, `commands`; continuam faltando `downloads`, `sidePanel`), mas **não salvou a Piloto** e traz
  interface de popup que o IdleHub teria de desenhar. É uma segunda etapa, só se houver demanda.
- **Scripts de usuário depois.** As ferramentas mais usadas (`/hunt`, Tools by Ateforp, Sniper) já
  existem como código de "mundo da página" sem `chrome.*`, então também viram `.user.js`. Mas um gerenciador
  de scripts (TAG-35) é mais código (GM_*, `@connect`, atualização) e cobre menos do que a comunidade usa hoje.
- **Os Termos do jogo permitem automação** (e citam a extensão de automação oficial, no Discord), dentro
  dos limites de sempre: até 4 contas por pessoa/rede, sem VPN/VPS/proxy, sem explorar falhas, sem
  sobrecarregar o servidor. O risco real é **a extensão enxergar a sessão da conta** e **mudar sozinha
  numa atualização**, por isso a TAG-36 (aviso de risco e versão travada) deve vir junto com a TAG-34.

## Como foi testado

A sonda fica em [`scripts/extensions-probe/`](../scripts/extensions-probe/) e pode ser rodada de novo:

```
node scripts/extensions-probe/run.js --ms=20000 probe <pasta-de-uma-extensao> ...
```

Para cada extensão ela: abre o Electron do projeto com uma sessão `persist:` **temporária** e uma pasta de
dados temporária; carrega a extensão; abre `https://pokeidle.io/` numa janela **escondida** (`show:false`),
com o mesmo preload das contas (`src/preload/game.js`, `sandbox`, `contextIsolation`,
`backgroundThrottling:false`); espera uns segundos e grava um relatório. Compara com uma execução **sem**
extensão (controle) para ver o que a extensão mudou na página. Não faz login, não clica em nada e não toca
em `%APPDATA%/IdleHub`.

O relatório mostra: se carregou, se o service worker subiu e se travou, quais mundos de script
(isolado/página) foram criados, erros de página e de service worker, chaves novas em `window`, elementos novos
no DOM e se o `WebSocket` foi trocado. A **extensão-sonda** (`scripts/extensions-probe/probe-ext/`) chama
dezenas de APIs `chrome.*` e conta o que responde.

Os arquivos baixados (extensões de terceiros) ficaram numa pasta temporária fora do repositório, nunca
foram executados fora do Electron e nenhum `npm install` foi rodado neles. **Nada disso está no repositório.**

**Limites do teste (importante):** sem login, só a página inicial e a tela de entrada (`/app` mostra o login
com captcha da Cloudflare) são alcançadas. Então o teste prova **carga, injeção e ausência de erros de API**,
mas **não prova** que cada recurso funciona logado (por exemplo, o painel da `/hunt` só calcula com o estado
da conta, vindo do WebSocket do jogo). Isso precisa de uma checagem manual com conta de teste antes de prometer
cada extensão.

## O que o Electron 45 entrega (medido pela sonda)

Documentação oficial: só lista como suportados `devtools.*`, `extension`, `management`, `runtime`
(parcial), `scripting`, `storage`, `system.storage`, `tabs` (parcial) e `webRequest`, e diz que o resto é
"provisório". Na prática, no 45.5.0:

| API / recurso | Resultado | Observação |
| --- | --- | --- |
| MV3 com service worker | ✅ | Sobe, dorme depois de ocioso e **acorda por `chrome.alarms`** (testado com alarme de 60 s) |
| Content script isolado e `world: "MAIN"` | ✅ | `document_start` e `document_idle`; o mundo isolado enxerga só `runtime`, `storage`, `i18n`, `scripting` |
| `runtime.sendMessage` / `onMessage` / `connect` | ✅ | Script → service worker e service worker → aba (`tabs.sendMessage`) |
| `storage.local`, `storage.sync`, `storage.session` | ✅ | Por sessão, ou seja, **separado por conta** |
| `alarms`, `idle`, `permissions`, `i18n` | ✅ | `management` existe, mas não foi exercitada |
| `scripting.executeScript` (isolado e MAIN) | ✅ | |
| `tabs` (`get`, `query`, `update`, `sendMessage`, `reload`) | ✅ parcial | `tabs.create` **não existe** |
| `declarativeNetRequest`, `offscreen` | ✅ | Existem; não foram exercitados a fundo |
| `fetch` do service worker | ✅ | Com `host_permissions` passa; sem elas, bloqueia por CORS (correto) |
| `action` (ícone, badge, popup) | ⚠️ | A API responde (`setBadgeText` "ok"), mas **não há ícone nem popup** na tela |
| `notifications`, `contextMenus`, `cookies`, `windows`, `downloads`, `commands`, `sidePanel`, `webNavigation` | ❌ | `chrome.<nome>` é `undefined`; o manifest dá aviso "Permission is unknown" |
| Arquivo `_metadata/` do pacote da loja | ✅ | Ignorado sem problemas |

Duas pegadinhas que importam para a TAG-34:

- **O ID da extensão depende da pasta** (extensão "descompactada"). A mesma `/hunt` recebeu IDs diferentes
  em duas pastas. O `chrome.storage` e a URL `chrome-extension://…` seguem o ID, então a pasta de instalação
  tem de ser estável (ou fixar o ID com `key` no manifest, que dá para tirar do cabeçalho do CRX).
- **Só vale na próxima carga da página.** O `loadExtension` precisa rodar a cada abertura do app e antes de a
  conta navegar; ligar uma extensão numa conta aberta exige recarregar a conta.

## Extensão × resultado

"Mundo da página" = content script em `world: "MAIN"`, que roda junto com o código do jogo.

| Extensão (versão) | O que faz | Resultado no Electron 45 | APIs que faltam / problemas |
| --- | --- | --- | --- |
| [/hunt for PokeIdle](https://chromewebstore.google.com/detail/hunt-for-pokeidle/mhnplloljgchpfpcpbhmcokmnefodjnh) 1.0.25 (Web Store) | Painel "onde caçar" por XP/h e ouro/h | ✅ Carrega, injeta, envolve o `WebSocket` do jogo, **sem erro** | Nenhuma: só content scripts no mundo da página, **zero** uso de `chrome.*`, sem service worker nem permissões. Sem licença declarada (não dá para embutir) |
| [Sniper do mercado](https://github.com/Romeu-q/ThoseIdles) (ThoseIdles, MIT) 1.0.0 | Compra automática no mercado; réplica própria do "Rotom Sniper" | ✅ Injeta (`__tiSniper`), sem erro | Nenhuma (mundo da página, sem `chrome.*`). O "Rotom Sniper" original é distribuído no Discord do jogo e **não foi obtido** |
| [Exportar shinies](https://github.com/Romeu-q/ThoseIdles) (ThoseIdles, MIT) 1.0.0 | Exporta a lista de shinies | ✅ | Nenhuma |
| [Tracker – Ritmo de XP](https://github.com/PedroLSCabral/pokeidletracker) 1.0.0 | Mostra o ritmo de XP | ✅ Cria `#pokeidle-ritmo-xp` na página | Nenhuma |
| [Deck Auto](https://github.com/astrathh/PokeDeck) (PokeDeck) 0.1.0 | Automação do app PokeDeck | ✅ Injeta (`__deckAuto`) | Nenhuma |
| [Tracker – Coletor](https://github.com/PedroLSCabral/pokeidletracker) 1.0.0 | Envia dados para um servidor local (`127.0.0.1`) | ✅ Service worker sobe; `runtime.connect` ok | Nenhuma (precisa do servidor local do autor) |
| [PokeIdle Tools by Ateforp](https://github.com/aasj94/PokeIdle-Tools) (MIT) 2.3.58 | Painel com PvE, PvP, compras e automações | ⚠️ Funciona: service worker sobe, painel é injetado (`#ateforp-wrap`, shadow DOM), 14 chaves novas na página | **Ícone da barra** (`action.onClicked` abre/fecha o painel): sem ícone, sem como alternar. Um erro de CSP do jogo ao conectar em `data:` (inofensivo). Existe também como `.user.js` |
| [PokeIdle Helper](https://github.com/guilhermevnbraga/pokeidle-helper) 1.0.0 | Painel "pkbot" (bolas, vendas, timing) | ✅ Em `/app` injeta a interface (+149 nós) e o service worker roda | Usa só `alarms`, `tabs.query/update/sendMessage`, que existem |
| [PokeIdle Piloto](https://github.com/DredsGG/pokeidle-piloto) 1.54.3 (licença não declarada) | Piloto automático: hunts, mercado, rotina, avisos | ❌ **Parcial**: content scripts injetam, mas o **service worker morre ao subir** (`Cannot read properties of undefined (reading 'onClosed')`, `chrome.notifications`) | `notifications`, `windows`, `commands`, `tabs.create`, `power`, `runtime.requestUpdateCheck`/`getBrowserInfo`, `permissions.request`. **Continua quebrando com o `electron-chrome-extensions`** |
| [Capture Tester](https://github.com/OtavioIdem/pokeidle_extension_capture) 1.2.0 | Teste de captura, só por popup | ⚠️ Carrega e não faz nada | Só funciona pelo **popup** (`action.default_popup`), que não existe no Electron |
| [PokeIdle Hub – Ponte](https://github.com/DevAndreNarcizo/PokeIDLE-Hub) 0.1.0 e [SDK da comunidade](https://github.com/duperez/pokeidle-community-sdk) | Ponte para um painel externo / exemplo | ⏭️ **Não testadas**: o repositório precisa de `npm run build`, e não se roda build de código de terceiros | A Ponte usa ícone, página de opções, `alarms` e `storage` |

Observações do teste:

- Os repositórios da comunidade foram lidos na versão do dia 27/11/2026 (`ThoseIdles@2ea860a`,
  `PokeIdle-Tools@3caf18e`, `pokeidle-piloto@0777e95`, `pokeidle-helper@16e7077`,
  `pokeidletracker@9008aab`, `PokeDeck@370ec65`, `pokeidle_extension_capture@5ff02fc`,
  `PokeIDLE-Hub@9ebe5f4`, `pokeidle-community-sdk@e093e0f`). A `/hunt` veio direto da Web Store
  (CRX3 pelo servidor de atualização do Google).
- Citadas pela comunidade mas **não obtidas** (Discord ou assinatura): o "Rotom Sniper" original, a
  extensão de automação oficial do jogo (Termos, seção 5), yPokeUtils e Idle Helper.
- Um app irmão (launcher em Electron) embutiu a `/hunt` na versão 1.1 e a **tirou na 1.2 porque a extensão
  parou de funcionar quando o jogo mudou**
  ([README](https://github.com/henriquecodo/launcher-alt-pokeidle)). Extensão de terceiros acompanha o jogo
  por conta do autor: é a principal razão para travar a versão (TAG-36) e para ter um "não compatível" claro.
- Uma extensão por conta cria um service worker **por conta** (uma sessão = um service worker). Não medimos
  memória logado; o ThoseIdles mediu +9 MB com a `/hunt` sem login. A `/hunt` carrega um bundle de ~800 KB em
  cada página. Medir com 4 contas antes de liberar (regra "os jogos nunca param").
- O ambiente de teste é igual ao das contas, e o `document.hidden = false` do preload já estava ativo quando
  o content script rodou (`hidden:false` em `document_start`). Não foi testado o login do Google com extensão
  ligada (as extensões vistas só casam `pokeidle.io`).

## E os scripts de usuário (`.user.js`)?

Quais dessas ferramentas existem ou poderiam virar userscript:

| Ferramenta | Já existe como `.user.js`? | Daria para portar? |
| --- | --- | --- |
| /hunt | Sim, há uma variante de script (o `boot.js` dela cita o "carregador do userscript") | Sim: só mundo da página, `@grant none` |
| Tools by Ateforp | **Sim**, oficial, `@grant none`, no mesmo repositório | Já pronto |
| Sniper, Shinies, Ritmo de XP, Deck Auto | Não | Trivial: já são mundo da página, sem `chrome.*` (copiar o arquivo) |
| Tracker (Coletor) | Sim, versão legada | Sim, mas precisa de `GM_xmlhttpRequest` para falar com o servidor local |
| Helper | Não | Parcial: o service worker (alarmes) precisaria virar `setInterval` |
| Piloto | Não | **Não** na prática: ~40 arquivos e muito `chrome.*` |
| [PokeIdle App](https://github.com/mentainf2-oss/pokeidle-app) (compras, sniper) | Sim | Precisa de `GM_xmlhttpRequest` e `unsafeWindow`. **Atenção: chama `api.anthropic.com`** (privacidade) |
| Party/Depot Analyzer, Hunting Helper, Hunt Atlas | Sim | `@grant none`, simples |

Leitura: os userscripts cobrem bem as ferramentas "leves" (as mesmas que já rodam como extensão sem nada),
mas o que dá **mais valor** (`/hunt`, Ateforp) já funciona como extensão, e a **instalação por extensão**
tem atualização e ecossistema prontos (Web Store). O que o userscript traz de extra é: independência da API
de extensões do Electron (que é "provisória"), instalação por colar código/URL e controle total da injeção.
O que ele custa: implementar `@match`, `@run-at`, `@grant`, `@require`, `GM_*`, `@connect` e atualização.

## Riscos

| Risco | Detalhe | O que fazer |
| --- | --- | --- |
| **Banimento** | Os [Termos](https://pokeidle.io/terms) (seção 5, "Automação") dizem que automações são permitidas, inclusive a extensão de automação oficial do Discord (#how-to-play), mas "não podem explorar falhas, burlar limites do jogo (contas por pessoa e por rede, travas do Mercado) nem sobrecarregar o servidor". Até **4 contas por pessoa**; **VPN, VPS e proxy proibidos**. Um sniper que consulta o mercado a cada poucos segundos em 4 contas pode virar "sobrecarga". Um documento de terceiros diz que bots por WebSocket sem navegador são proibidos; **não encontrei isso nos Termos**, mas extensões só leem o WebSocket que a própria página abre | Desligado por padrão, aviso claro, ativado **por conta**, nunca "todas de uma vez" |
| **Acesso à sessão** | Código no mundo da página lê `localStorage`, o WebSocket e tudo que o jogo lê; um service worker com `host_permissions` faz `fetch` **com os cookies** da conta. Extensão com `<all_urls>` veria até o login do Google | Aceitar só MV3 com `matches`/`host_permissions` limitados aos endereços do jogo; recusar `<all_urls>`, `cookies`, `webRequest`, `debugger`; mostrar as permissões antes (TAG-36) |
| **Atualização maliciosa ou quebrada** | A Web Store atualiza sozinha; o autor pode mudar o comportamento (ou o jogo mudar e a extensão quebrar, como no launcher irmão) | Travar a versão (hash SHA-256), atualizar só a pedido, com resumo do que mudou (TAG-36) |
| **Dados saindo do PC** | Há ferramentas que enviam dados a servidores do autor (Tracker/Hub) ou a IA externa (PokeIdle App → `api.anthropic.com`) | Mostrar os destinos de rede no resumo de risco |
| **Os jogos nunca param** | Cada extensão acrescenta processos e memória por conta | Medir com 4 contas logadas; não mexer em `backgroundThrottling`, nem nas chaves de `main.js`; as extensões testadas não alteraram `document.hidden` |
| **Login do Google** | Os ajustes de login (`src/main/accounts.js`, `src/preload/game.js`) não podem ser tocados | Só liberar extensões cujo `matches` seja o domínio do jogo; testar o login com extensão ligada |
| **Licença** | `/hunt` e Piloto não declaram licença; Ateforp e ThoseIdles são MIT | **Não embutir** no instalador; baixar da fonte quando a pessoa pedir (como o ThoseIdles faz) |

## Recomendação

**Priorizar extensões, nesta ordem:**

1. **TAG-34 + TAG-36 juntas, com escopo estreito.** Extensões MV3 "leves": content scripts + (opcional)
   service worker, `storage`, `alarms`, `scripting`, mensagens. É onde estão `/hunt`, Ateforp, Helper e
   as ferramentas de mercado, e é o que o Electron 45 já entrega sem biblioteca extra. Publicar uma
   **lista de compatíveis** (testados) e dizer claramente "não compatível" para o que usa `notifications`,
   `windows`, `commands`, `tabs.create`, popup etc. (hoje, a Piloto).
2. **TAG-35 (userscripts) logo depois**, começando por `@grant none` (+ `unsafeWindow`, `GM_getValue/
   setValue`, `GM_addStyle`); `GM_xmlhttpRequest` só com `@connect` mostrado e confirmado pela pessoa. Reaproveita
   a mesma injeção no mundo da página que o `src/preload/game.js` já faz com `webFrame.executeJavaScript`.
3. **Só se houver pedido:** o `electron-chrome-extensions` (ícone/popup, `notifications`, `contextMenus`,
   `windows`…) para as extensões que dependem de interface. Não resolve a Piloto.

Por que extensões antes de scripts: a ferramenta mais citada já funciona como está; a Web Store dá
descoberta e atualização; e o trabalho é pequeno (carregar por sessão) comparado a um gerenciador de scripts.
Por que não "só extensões": a API de extensões do Electron é declarada "provisória", então vale ter o
userscript como plano B para o que é só código de página.

## Plano ajustado para TAG-34, TAG-35 e TAG-36

### TAG-34: instalar extensões do Chrome por conta

- **Módulo novo `src/main/extensions.js`** (com teste em `test/`): guarda as extensões em
  `%APPDATA%/IdleHub/extensions/<id>/<versão>` (pasta **estável**, por causa do ID) e o estado em
  `config.json` (quais extensões, em quais contas, versão e hash travados).
- **Instalar pela Web Store** (link ou ID): baixar o CRX3 pelo servidor de atualização do Google
  (`clients2.google.com/service/update2/crx`), conferir **tamanho e SHA-256** informados pelo servidor, ler o
  cabeçalho CRX3, conferir que o ID bate com a chave pública do cabeçalho, tirar o cabeçalho e descompactar
  (sem pacote novo: `zlib` do Node com um leitor de zip pequeno, ou `tar.exe` do Windows), apagar `_metadata/`
  e (opcional) gravar `key` no manifest para fixar o ID. **Instalar de pasta local** também.
- **Validar o manifest antes de aceitar:** MV3; `content_scripts.matches` e `host_permissions` só dentro dos
  endereços do jogo; recusar `<all_urls>`, `cookies`, `webRequest`, `debugger`, `nativeMessaging`; recusar
  caminhos com `..`.
- **Carregar por conta:** em `createView` (`src/main/accounts.js`), antes da primeira navegação,
  `session.fromPartition(partitionFor(...)).extensions.loadExtension(pasta)` para as extensões ligadas **nessa**
  conta. Ligar/desligar recarrega só aquela conta. "Copiar para outras contas" apenas liga a mesma extensão.
- **Interface (`src/renderer`):** nova seção "Extensões" com a lista, o selo "testada/compatível" ou "não
  compatível", o interruptor **por conta** e o botão "Opções" (abre a página de opções num `BrowserWindow`,
  tratando como janela: `S.modal`, as contas escondidas). **Sem ícone/popup na primeira versão**, dito de forma
  clara. Seguir o `DESIGN.md`.
- **Limitações a dizer na tela:** extensões que precisam de popup, `notifications`, `windows` etc. não funcionam.
- **Testes:** validador de manifest, leitor de CRX, caminhos/IDs. O `scripts/extensions-probe` serve de teste
  manual a cada troca de versão do Electron.
- **Aceite:** `/hunt` instalada pela loja carrega nas contas escolhidas, mede-se RAM/CPU com 4 contas, e os
  jogos continuam rodando minimizados (regra principal).

### TAG-35: scripts de usuário (feito)

> **Status:** implementado (`src/main/userscripts.js`, `userscript-store.js`, `netfetch.js`; aba **Scripts de usuário** na janela Extensões). As fases 1 e 2 abaixo
> foram entregues juntas. O que ficou **diferente do plano** e por quê:
>
> - **Injeção pelo preload, não por `webContents.executeJavaScript` do main:** o preload (`src/preload/game.js`) pergunta por `sendSync` quais scripts rodam
>   *naquela* página da conta (o main confere conta, site do jogo, `@match` e o hash do arquivo) e executa cada um na hora do `@run-at`. Só assim o
>   `document-start` roda antes do jogo, e a recarga/navegação da conta reinjeta sozinha. Sem o login do Google (nem o pedido é feito).
> - **`@grant none` (ou sem `@grant`) = mundo da página** (`webFrame.executeJavaScript`); **com `GM_*` = mundo isolado, um por script**
>   (`webFrame.executeJavaScriptInIsolatedWorld`), com uma ponte `idleHubGM` criada por `contextBridge.exposeInIsolatedWorld`: ela só existe *naquele* mundo,
>   nunca no `window` da página (conferido no app: a página vê `typeof idleHubGM === 'undefined'`), e cada ponte só fala em nome do próprio script.
>   Todo pedido da ponte é conferido de novo no main (conta ligada, frame principal, página que casa, `@grant` pedido).
> - **`unsafeWindow`** só existe quando o script roda no mundo da página (é a própria `window`). Junto com `GM_*` fica indefinido (o mundo isolado não enxerga
>   as variáveis do jogo, e expor o mundo da página violaria a regra do AGENTS.md); a tela avisa "Funciona em parte". Foi o que sobrou do **PokeIdle App**.
> - **`@require` e `@resource` são recusados** (código baixado de outro site poderia mudar depois do "sim"; a versão travada perderia o sentido). A tela diz para
>   usar uma versão do script com tudo dentro do arquivo. Fica para uma versão futura (baixar, travar o hash do `@require` e mostrar no resumo).
> - **`GM_xmlhttpRequest`:** só para os hosts do `@connect` (e subdomínios; `self` = o site da página; `localhost` e IPs só se declarados; `*` é recusado na
>   instalação), sem cookies, sem cabeçalhos `Cookie`/`Host`/`Origin`/`Sec-*`, com limites (60 s, 2 MB de corpo, 10 MB de resposta, 4 ao mesmo tempo) e cada
>   redirecionamento conferido *antes* de ser seguido. O `net.fetch` do Electron não aceita `redirect: 'manual'`, então há um adaptador sobre `net.request`
>   (`netfetch.js`). Cancelam sozinhos ao dormir, otimizar, desligar ou remover.
> - **Atualização:** pelo `@downloadURL`/`@updateURL` (`.meta.js` vira `.user.js`) ou pelo link de instalação, só em Greasy Fork, OpenUserJS e GitHub; ou **colando o código novo**.
> - **Não feito:** menu do script (`GM_registerMenuCommand` é um vazio), `GM_openInTab`/`GM_download`/`GM_setClipboard`, scripts em `iframe`, `@include` com expressão regular.

- **Fase 1 (`@grant none`):** parser do cabeçalho (`@name`, `@match`, `@exclude`, `@run-at`, `@grant`),
  injeção no mundo da página a partir do preload (o texto do script vem por IPC, pois o preload é `sandbox`) e
  por conta. Já cobre `/hunt`, Ateforp, Sniper, Shinies, Ritmo de XP, Deck Auto e os scripts do Party/Depot.
- **Fase 2 (`GM_*`):** `GM_getValue/setValue/deleteValue`, `GM_addStyle`, `GM_notification` (via app),
  `GM_xmlhttpRequest` pela main com **lista `@connect` confirmada pela pessoa** e sem cookies da conta por
  padrão. Nada do app exposto à página (regra do `AGENTS.md`).
- **Instalar:** colar o código ou um link (Greasy Fork / OpenUserJS / GitHub raw), com a mesma tela de aviso.
- **Depende de** TAG-34 só pela tela de risco e pelo interruptor por conta (reaproveitar).

### TAG-36: aviso de risco e versão travada

- **Resumo antes de instalar** (extensão e script): permissões, sites que alcança, destinos de rede
  encontrados no código (`fetch`, `XMLHttpRequest`, `WebSocket`, `http(s)://` literais), sinais de
  automação (`.click()`, `dispatchEvent`, `eval`/`new Function`) e o **aviso de possível ban**, citando os
  limites dos Termos (4 contas, sem VPN/VPS, sem explorar falhas).
- **Versão travada:** guardar o SHA-256 do CRX/script instalado; **nenhuma atualização automática**. "Procurar
  atualização" baixa a nova, compara manifest (permissões novas, sites novos) e arquivos, mostra o que mudou
  e só então troca. Voltar para a versão anterior (manter a pasta antiga).
- **Aceite:** instalar duas vezes a mesma versão dá o mesmo hash; uma versão com permissão nova **não** entra
  sem confirmação.

## Fontes

Electron e Chrome
- Electron, [Chrome Extension Support](https://www.electronjs.org/docs/latest/api/extensions) e
  [`Extensions`](https://www.electronjs.org/docs/latest/api/extensions-api) (também em `docs/api/extensions.md` do
  [repositório](https://github.com/electron/electron/blob/main/docs/api/extensions.md)).
- Chrome, [API de extensões](https://developer.chrome.com/docs/extensions/reference/api).
- [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions)
  4.10.0 (MIT) e [no npm](https://www.npmjs.com/package/electron-chrome-extensions).
- Tampermonkey, [documentação de `GM_*`](https://www.tampermonkey.net/documentation.php).

PokeIdle e comunidade
- [Termos do PokeIdle](https://pokeidle.io/terms) (versão 12/10/2026, revisão 22/11/2026), seções 5 e 6.
- [/hunt for PokeIdle](https://chromewebstore.google.com/detail/hunt-for-pokeidle/mhnplloljgchpfpcpbhmcokmnefodjnh)
  (Chrome Web Store).
- [ThoseIdles](https://github.com/Romeu-q/ThoseIdles) (README, seções da `/hunt` e do Sniper),
  [PokeIdle Tools by Ateforp](https://github.com/aasj94/PokeIdle-Tools),
  [PokeIdle Piloto](https://github.com/DredsGG/pokeidle-piloto),
  [PokeIdle Helper](https://github.com/guilhermevnbraga/pokeidle-helper),
  [PokeIdle Tracker](https://github.com/PedroLSCabral/pokeidletracker),
  [PokeDeck](https://github.com/astrathh/PokeDeck),
  [Capture Tester](https://github.com/OtavioIdem/pokeidle_extension_capture),
  [PokeIdle Hub](https://github.com/DevAndreNarcizo/PokeIDLE-Hub),
  [SDK da comunidade](https://github.com/duperez/pokeidle-community-sdk),
  [PokeIdle App (userscript)](https://github.com/mentainf2-oss/pokeidle-app),
  [Party/Depot Analyzer](https://github.com/M0abl1/pokeidle-manager),
  [Hunting Helper](https://github.com/Takeces/Pokeidle-Hunting-Helper),
  [Hunt Atlas / pokeidle-addons](https://github.com/MOTHblank/pokeidle-addons).
- Um launcher em Electron que tirou a `/hunt` quando ela parou:
  [launcher-alt-pokeidle](https://github.com/henriquecodo/launcher-alt-pokeidle).
