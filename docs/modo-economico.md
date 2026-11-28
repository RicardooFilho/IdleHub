# Modo econômico por foto: dá para fazer sem parar os jogos?

Resultado da tarefa **TAG-18** ("Modo econômico por foto (medir antes)").
Ideia: a conta que não está na tela mostra uma **foto** (`capturePage`) atualizada de tempos em tempos, em vez
de uma vista ao vivo, para gastar menos GPU e memória; "Espiar" mostraria a conta ao vivo. Regra do projeto:
**só vale se os jogos continuarem rodando a 100%** (veja o [AGENTS.md](../AGENTS.md)). Então medimos antes.

Testes feitos em 27/11/2026, com o Electron **45.5.0** (Chromium 156) do próprio IdleHub, no Windows 11,
num PC com 16 núcleos lógicos.

## Resumo (para decidir)

- **Decisão: não implementar o modo econômico agora.** Nenhum modo passou nos critérios. O recurso **não foi
  construído**; esta tarefa entrega só a sonda e este relatório.
- **O que se mantém em 100% em todos os modos** (inclusive tirando a view da janela): `setInterval`, o progresso
  calculado com `Date.now()` e as mensagens de WebSocket (mesma taxa, atraso de 1 a 2 ms). Nada disso mudou em
  9 minutos seguidos (a "limitação intensiva" do Chromium, que começa depois de 5 minutos, não apareceu).
- **O que falha em todos os modos que realmente economizam:**
  1. **`setTimeout` encadeado fica de 5% a 16% mais lento** (de 97% do esperado para 81% a 92%, conforme o PC).
     Jogo que conta progresso "um passo a cada `setTimeout`" andaria mais devagar.
  2. **`requestAnimationFrame` cai para 0 a 1 quadro por segundo** (piso do projeto: 30). Jogo que conta
     progresso por quadro andaria a ~3% da velocidade (modos "escondida", "0×0", "fora da tela") ou **pararia**
     (modos "tirada da janela" e "limitar").
- **O que a medição mostrou sobre o app de hoje (vale uma conversa à parte):**
  - A conta **escondida** (`setVisible(false)`, o que o app faz com a que não está na tela) **já está nesse
    estado econômico**: 1 quadro/s, CPU 0,3% (contra 6,3% visível) e `setTimeout` encadeado já mais lento.
    Ou seja, o app já economiza para as escondidas, com o mesmo custo para os jogos. Um modo econômico só
    ganharia algo em contas **na tela** (mosaico) que a pessoa não está olhando, trocando o ganho pelo custo acima.
  - **Janela minimizada** (mesmo com a conta "visível") também cai para 1 quadro/s. O texto do AGENTS.md diz
    que o limite de FPS "só reduz a animação" e que o piso é 30; na prática, escondida ou minimizada, o Chromium
    reduz ainda mais. Precisa ser confirmado no app real, com os jogos reais.
  - **Janela escondida para a bandeja** (`win.hide()`): as contas **continuam desenhando a 30 quadros/s**
    (6% de CPU do PC e 3% de GPU só com 4 contas de teste). É o único ganho "de graça" que apareceu, mas ele
    esbarra no mesmo custo (1 quadro/s e `setTimeout` mais lento) se for aproveitado.
  - **Janela coberta por outra**: nada muda (30 quadros/s). Esperado: a chave `disable-backgrounding-occluded-windows`
    desliga a detecção de cobertura (inferência, veja os limites).
- **Se mesmo assim quiserem a foto** (decisão de produto, com aviso claro e desligada por padrão): a técnica
  funciona e é barata. Usar **`view.setVisible(false)`**, nunca tirar a view da janela (a captura trava: 0 de 16),
  `capturePage` com `stayHidden` (~5 ms e ~0,1% de CPU a cada 5 s com 4 a 8 contas), reduzida para 320 px de
  largura (~250 KB por conta na memória). O ganho vem **só** de parar o desenho ao vivo das contas na tela
  (4 contas: 6,3% → 0,3% de CPU e 378 → 153 MB; 8 contas: 12,2% → 0,5% e 762 → 314 MB).

## Como foi testado

A sonda fica em [`scripts/economy-probe/`](../scripts/economy-probe/) e pode ser rodada de novo:

```
node scripts/economy-probe/run.js --modes=visible,hidden,removed --states=normal,minimized --ms=120000 --out=resultado.jsonl
node scripts/economy-probe/run.js --modes=hidden --states=normal --capture=5000,15000,30000 --accounts=4,8
```

Para cada cenário o `main.js` abre o Electron do projeto com pasta de dados **temporária** e 4 contas de teste (ou 8)
como `WebContentsView`, cada uma com **sessão separada** (processo próprio), com as **mesmas** `webPreferences` das
contas reais (`sandbox`, `contextIsolation`, `backgroundThrottling: false`), o **mesmo preload**
(`src/preload/game.js`: `document.hidden = false`, limitador de FPS em 30, rastreio de WebSocket) e as **mesmas
três chaves** do Chromium de `src/main/main.js`. A página de teste (`page.html`) vem de um servidor local numa
porta livre sorteada (nunca a 3000) e imita um jogo: canvas animado, texto mudando, vários temporizadores e um
WebSocket que recebe 10 mensagens por segundo. Sem login, sem internet, sem dados reais.

Sequência de cada cenário: carrega as páginas visíveis → espera 8 s → aplica o **modo** nas views e o **estado**
na janela → espera 8 s → zera os contadores → mede por **120 s** (os de longa duração, 540 s).

O que se mede **dentro da página**, comparado com o relógio: `setInterval` de 100 ms (ticks contados),
`setTimeout` encadeado de 50 ms (disparos contados), progresso somando a diferença de `Date.now()`,
`requestAnimationFrame` (já com o limitador) e as mensagens do WebSocket (quantidade e atraso entre a hora do
servidor e a de chegada). **Fora**: CPU e memória de cada processo (`app.getAppMetrics`, a cada 5 s), com a GPU
separada, e o tempo do `executeJavaScript` (o que o watchdog e os alertas usam). As tabelas mostram, entre as contas,
o **pior** valor das razões (a conta mais atrasada).

**Modos** (o que se faz com a view fora da tela): `visível` (referência); **`escondida`** = `setVisible(false)`, o que
o app faz hoje; `tirada da janela` = `removeChildView`; `0×0`; `fora da tela` (posição −20000); e os dois últimos mais
`setBackgroundThrottling(true)` (`escondida + limitar`, `tirada + limitar`; isso **muda a regra de ouro** e só entrou
para medir). **Estados da janela:** `normal`; `minimizada`; `coberta` (outra janela opaca por cima, sempre no topo);
`bandeja` (`win.hide()`). As janelas de teste (760×480) aparecem no canto da tela, sem tomar o foco, e se fecham sozinhas.

**A CPU** é do PC inteiro, como no Gerenciador de Tarefas: calibramos com uma página que usa metade de um núcleo e o
Electron mostrou 3,04% num PC de 16 núcleos (= 50/16). Então 6,25% é um núcleo cheio. A memória é a "memória privada".

## Resultados: 4 contas, 120 s por cenário

`setInterval`, `setTimeout` e `Date`: % do que o relógio esperaria (100% = igual), na pior conta. O progresso por
`Date` só avança dentro do `setInterval`, por isso acompanha ele.

| Modo | Janela | setInterval | setTimeout | Date | WS msg/s | Atraso WS p95 | rAF (fps) | CPU total | CPU GPU | Mem. contas | Mem. GPU |
|---|---|---|---|---|---|---|---|---|---|---|---|
| visível (referência) | normal | 100,0% | 96,9% | 100,0% | 9,4/s | 1 ms | 30,0 | 6,34% | 2,92% | 378 MB | 87 MB |
| visível (referência) | minimizada | 100,0% | 90,3% | 100,0% | 9,6/s | 1 ms | 1,0 | 0,28% | 0,12% | 153 MB | 97 MB |
| visível (referência) | coberta | 100,0% | 97,5% | 99,9% | 9,6/s | 1 ms | 30,0 | 5,80% | 2,36% | 378 MB | 90 MB |
| visível (referência) | bandeja | 100,0% | 97,4% | 99,9% | 9,5/s | 1 ms | 29,9 | 6,04% | 2,50% | 377 MB | 87 MB |
| **escondida (como hoje)** | normal | 100,0% | 90,7% | 99,9% | 9,6/s | 1 ms | 1,0 | 0,27% | 0,11% | 153 MB | 105 MB |
| **escondida (como hoje)** | minimizada | 100,0% | 90,6% | 100,0% | 9,6/s | 1 ms | 1,0 | 0,28% | 0,12% | 156 MB | 99 MB |
| **escondida (como hoje)** | coberta | 100,0% | 91,7% | 99,9% | 9,6/s | 1 ms | 1,0 | 0,26% | 0,11% | 153 MB | 104 MB |
| **escondida (como hoje)** | bandeja | 100,0% | 97,5% | 99,9% | 9,6/s | 1 ms | 30,0 | 6,37% | 2,60% | 381 MB | 88 MB |
| tirada da janela | normal | 100,0% | 90,5% | 99,9% | 9,6/s | 1 ms | 0,0 | 0,12% | 0,01% | 148 MB | 92 MB |
| tirada da janela | minimizada | 100,0% | 91,2% | 100,0% | 9,6/s | 1 ms | 0,0 | 0,12% | 0,01% | 148 MB | 84 MB |
| tirada da janela | coberta | 100,0% | 91,4% | 100,0% | 9,6/s | 1 ms | 0,0 | 0,12% | 0,01% | 144 MB | 93 MB |
| tirada da janela | bandeja | 100,0% | 90,2% | 100,0% | 9,6/s | 1 ms | 0,0 | 0,13% | 0,01% | 150 MB | 87 MB |
| tamanho 0×0 | normal | 100,0% | 91,1% | 100,0% | 9,6/s | 1 ms | 1,0 | 0,28% | 0,12% | 152 MB | 105 MB |
| tamanho 0×0 | minimizada | 100,0% | 92,5% | 100,0% | 9,7/s | 1 ms | 1,0 | 0,29% | 0,12% | 154 MB | 98 MB |
| tamanho 0×0 | coberta | 100,0% | 92,5% | 100,0% | 9,7/s | 1 ms | 1,0 | 0,28% | 0,12% | 157 MB | 104 MB |
| tamanho 0×0 | bandeja | 100,0% | 97,5% | 100,0% | 9,6/s | 1 ms | 30,0 | 6,26% | 2,54% | 384 MB | 89 MB |
| fora da tela (−20000) | normal | 100,0% | 87,3% | 100,0% | 9,5/s | 1 ms | 1,0 | 0,28% | 0,12% | 151 MB | 106 MB |
| fora da tela (−20000) | minimizada | 100,0% | 81,3% | 99,9% | 9,2/s | 1 ms | 1,0 | 0,33% | 0,14% | 151 MB | 99 MB |
| fora da tela (−20000) | coberta | 100,0% | 81,2% | 99,9% | 9,2/s | 1 ms | 1,0 | 0,28% | 0,13% | 156 MB | 103 MB |
| fora da tela (−20000) | bandeja | 100,0% | 97,1% | 99,9% | 9,3/s | 1 ms | 29,9 | 6,43% | 2,64% | 384 MB | 87 MB |
| escondida + limitar | normal | 100,0% | 81,2% | 99,9% | 9,3/s | 1 ms | 0,0 | 0,11% | 0,00% | 144 MB | 92 MB |
| escondida + limitar | minimizada | 100,0% | 81,2% | 99,9% | 9,3/s | 1 ms | 0,0 | 0,09% | -0,00% | 145 MB | 83 MB |
| escondida + limitar | coberta | 100,0% | 81,3% | 99,9% | 9,3/s | 1 ms | 0,0 | 0,11% | 0,00% | 148 MB | 91 MB |
| escondida + limitar | bandeja | 100,0% | 81,3% | 100,0% | 9,3/s | 1 ms | 0,0 | 0,11% | 0,00% | 147 MB | 87 MB |
| tirada + limitar | normal | 100,0% | 81,2% | 100,0% | 9,3/s | 1 ms | 0,0 | 0,11% | 0,00% | 142 MB | 92 MB |
| tirada + limitar | minimizada | 100,0% | 81,1% | 99,9% | 9,2/s | 1 ms | 0,0 | 0,13% | 0,01% | 147 MB | 83 MB |
| tirada + limitar | coberta | 100,0% | 81,2% | 99,9% | 9,2/s | 1 ms | 0,0 | 0,13% | 0,00% | 144 MB | 91 MB |
| tirada + limitar | bandeja | 100,0% | 81,2% | 99,9% | 9,2/s | 1 ms | 0,0 | 0,12% | 0,00% | 147 MB | 83 MB |

Para ler:

- **Referência** (visível, janela normal): 30 fps, 6,3% de CPU, 378 MB.
- `setInterval`, `Date` e WebSocket: **iguais em todas as 28 linhas**. A taxa do WebSocket varia de 9,2 a 9,7/s porque o
  servidor de teste manda com a precisão do relógio do Windows; o **atraso** de entrega, que seria o sinal de
  atraso real, ficou em 1 a 2 ms em todas.
- `setTimeout`: a referência dá 97%; **todo cenário sem desenho ao vivo cai** (81% a 92%). A perda variou entre rodadas
  do mesmo modo no mesmo PC (a "escondida" deu ~90% na primeira rodada e ~81% nas seguintes). Isso indica que depende
  do relógio de timer do Windows no momento (a página escondida perde a alta resolução e cada disparo vira múltiplo
  de ~15,6 ms), **não** do modo. Por isso o relatório fala em "5% a 16%" e não num número só.
- `bandeja`: fora os modos "tirada" e "limitar", **o desenho continua a 30 fps** mesmo com a view escondida, 0×0 ou fora da tela.
- **Longa duração** (4 contas, 540 s, janela normal): visível, escondida e tirada da janela. `setInterval` e WebSocket
  ficaram em 100% do começo ao fim (maior intervalo entre ticks: 133 ms), `setTimeout` ficou em 96,4% / 81,3% / 81,6% e o
  rAF em 29,9 / 1,0 / 0 fps, **sem piora depois dos 5 minutos**.

### Com 8 contas (janela normal)

| Modo | setTimeout | rAF (fps) | CPU total | CPU GPU | Mem. contas | Mem. GPU |
|---|---|---|---|---|---|---|
| visível | 96,4% | 29,9 | 12,20% | 4,37% | 762 MB | 92 MB |
| escondida | 81,5% | 1,0 | 0,50% | 0,17% | 314 MB | 117 MB |

### Custo do `capturePage` (modo "escondida", janela normal)

Uma conta de cada vez, espalhadas dentro do intervalo; depois reduz para 320 px de largura. "Fotos" = capturas que voltaram com imagem (não vazia). Em todas, a imagem mudou de uma captura para a seguinte
(o canvas de teste anda sempre), então não era foto velha.

| Contas | Intervalo | Fotos | Tempo de cada foto (média / p95) | CPU total | Mem. contas | setInterval |
|---|---|---|---|---|---|---|
| 4 | sem foto | — | — | 0,27% | 153 MB | 100% |
| 4 | 30 s | 16 de 16 | 6,8 ms / 11 ms | 0,35% | 157 MB | 100% |
| 4 | 15 s | 32 de 32 | 6,3 ms / 13 ms | 0,36% | 155 MB | 100% |
| 4 | 5 s | 96 de 96 | 5,0 ms / 8 ms | 0,42% | 166 MB | 100% |
| 8 | sem foto | — | — | 0,50% | 314 MB | 100% |
| 8 | 30 s | 32 de 32 | 4,7 ms / 8 ms | 0,50% | 317 MB | 100% |
| 8 | 15 s | 64 de 64 | 4,0 ms / 6 ms | 0,52% | 309 MB | 100% |
| 8 | 5 s | 192 de 192 | 4,5 ms / 7 ms | 0,64% | 320 MB | 100% |

- Cada foto reduzida tem **~250 KB** (320×202) e ficaria só na memória, sem arquivo.
- **O que dá para fotografar:** escondida (`setVisible(false)`), 0×0 e fora da tela: sim. **Tirada da janela: não**
  (as 16 tentativas deram "timeout"). Com a conta visível a foto leva ~13 ms.
- `stayHidden` ligado ou desligado deu o mesmo custo (5 ms), e `executeJavaScript` seguiu respondendo em menos de
  1,5 ms em todos os modos (o watchdog e os alertas continuam funcionando).
- A foto **não atrapalhou** os temporizadores: `setInterval` em 100%, atraso do WebSocket igual ao dos testes sem foto.

## Critérios e veredito

| Critério | escondida | tirada da janela | 0×0 | fora da tela | + limitar |
|---|---|---|---|---|---|
| `setInterval`, `Date`, WebSocket em ±2% (todos os estados) | passa | passa | passa | passa | passa |
| `setTimeout` em ±2% (todos os estados) | **falha** (81–92%) | **falha** (81–92%) | **falha** | **falha** | **falha** (81%) |
| rAF no piso de 30 fps | **falha** (1 fps) | **falha** (0 fps) | **falha** (1 fps) | **falha** (1 fps) | **falha** (0 fps) |
| Dá para fotografar | sim | **não** | sim | sim | sim (escondida) / não (tirada) |
| Poupa de verdade na bandeja | não (desenha a 30 fps) | sim | não | não | sim |

**Nenhum modo passa**, então o modo econômico não foi implementado. O ganho existe e é grande (~95% de CPU e ~60% de
memória nas contas que saem do desenho ao vivo), mas é exatamente o ganho de **parar de desenhar**, e é isso que
atrasa o `setTimeout` e para o `requestAnimationFrame`. Não há como ter um sem o outro com as chaves de hoje (os
modos "limitar" dão o mesmo atraso nos temporizadores e param o rAF de vez).

### Próximos passos sugeridos (fora desta tarefa)

1. **Confirmar no app real** o que o AGENTS.md assume: com contas reais, escondidas e minimizadas, o rAF cai para 1 fps
   e o `setTimeout` perde 5% a 16%? Se sim, o texto "o limite de FPS só reduz a animação" precisa ser corrigido, e
   aceitar isso nas escondidas (o que já acontece hoje) vira uma decisão consciente.
2. Decidir se a **bandeja** deve esconder as views (ganho de ~6% de CPU com 4 contas), pagando o mesmo custo.
3. Se o modo econômico voltar: por jogo (opt-in), desligado por padrão, com aviso de que "jogos que contam por
   quadro ou por `setTimeout` andam mais devagar", usando `setVisible(false)` + `capturePage` a cada 15 s.

## Monitor de 240 Hz (28/11/2026)

Medido no mesmo PC, agora com monitor de **239 Hz**, 4 contas visíveis, 60 s por rodada (`--fps=…`).

| Limite | rAF (fps) | setTimeout | CPU total |
|---|---|---|---|
| sem limite (era o da conta expandida) | 211 a 237 | 94% a 98% | 15,5% a 15,9% |
| 60 (novo padrão da conta expandida, `focusFps`) | 59 a 60 | 97% a 98% | 9,1% |
| 30 (mosaico) | 30 | 98% | 7,1% a 7,7% |

- Sem limite, a conta desenha na taxa do monitor. Por isso a conta expandida ganhou o limite `focusFps` (60).
- **Testado e descartado:** no quadro pulado, esperar com `setTimeout` até a hora do próximo, em vez de pedir outro
  `requestAnimationFrame` a cada atualização do monitor. Em rodadas alternadas (antigo, novo, antigo, novo) economizou só
  0,5 a 1 ponto de CPU com 4 contas e deixou o `setTimeout` encadeado em **87% a 89%** (contra 98% do limitador de hoje).
  Acordar a cada atualização do monitor é o que mantém o relógio de alta resolução do Windows ligado para a página.
- Baixar o FPS do mosaico **quase não economiza**: 30 → 15 → 10 deu 7,6% → 7,2% → 7,1%. O custo vem do Chromium
  trabalhando no ritmo do monitor (animações de CSS, composição, GPU), não do desenho do jogo.
- **O que resolve: `fake-vsync-rate`** (agora em `src/main/main.js`), que dá ao Chromium um ritmo de quadros fixo no lugar
  do monitor. Com 60, ele entrega só ~56,5 quadros/s e o mosaico fica em 28 (abaixo do piso de 30); com **64**, fica em 30.

| `fake-vsync-rate` | Limite | rAF (fps) | setTimeout | CPU total |
|---|---|---|---|---|
| (do monitor, 239 Hz) | 30 | 30 | 98% | 7,1% a 7,7% |
| 60 | 30 | 28,2 | 98% | 3,1% |
| **64** | **30** | **30,0** | **98%** | **3,2%** |
| **64** | **60** | **59,8** | **98%** | **5,0%** |
| 64 | sem limite | 59,9 | 98% | 4,9% |
| 60 | escondida / minimizada | 1,0 | 98% | 0,3% |

  `setInterval`, `Date` e WebSocket ficaram em 100% em todas. `disable-gpu-vsync` sozinha não mudou nada (7,7%).
  Não medido: monitor de 60 Hz (o app passa a desenhar a 64 em vez de 60, ~7% a mais na pior hipótese) e se a imagem
  fica com cortes (*tearing*) em algum PC.
- **Bandeja**: com `win.hide()` as contas seguem desenhando a 30 quadros/s, mesmo escondidas (`setVisible(false)`):
  2,4% de CPU com 4 contas. **Minimizada e fora da barra de tarefas** (`setSkipTaskbar(true)` + `minimize()`, estado
  `tray-min` da sonda): 0,2%, rAF a 1 quadro/s (como minimizar à mão) e `setTimeout` igual (98%). O app passou a fazer
  assim (`hideToTray()` em `src/main/main.js`). Nos jogos reais, minimizar levou o app de ~38% para ~8% da CPU do PC.
- **Garagem e textura** (o que o IdleDeck faz), medidas e **não adotadas**:

| Modo (4 contas) | rAF (fps) | setTimeout | CPU total |
|---|---|---|---|
| visível, limitador do app a 20 / 10 / 6 | 20 / 10 / 6 | 98% | 1,8% / 1,5% / 1,4% |
| textura (`offscreen` + `useSharedTexture` + `setFrameRate`) a 20 / 10 / 6 / 1 | 20 / 10 / 6 / 1 | 98% | 3,3% / 2,1% / 1,2% / 0,2% |
| escondida, janela normal ou minimizada (o de hoje) | 1 | 98% | 0,2% |
| garagem (janela fora dos monitores + página de 1x1 mudando de cor a cada 100 ms) | 10 | 98% | 0,8% |
| garagem sem a página que pisca, minimizada | 1 | 98% | 0,2% |

  A textura não gasta menos que o limitador do app até 10 quadros/s e exigiria repassar mouse e teclado à mão. A garagem
  só troca 0,2% por 0,8% para ter 10 quadros/s nas escondidas. Nos jogos reais, baixar o FPS do mosaico de 30 para 10
  **quase não mudou a CPU**: o peso é desenhar a conta na tela (minimizar resolve), não a animação que o limitador alcança.
  Os `setTimeout` em 98% nesta rodada (contra 81% a 92% na primeira) mostram que ele depende do relógio do Windows no momento.
- Para experimentar outras chaves na sonda: `IDLEHUB_PROBE_SWITCHES="chave,chave=valor"` e `IDLEHUB_PROBE_VSYNC=60`.
- A sonda agora responde ao `us:plan` do preload (scripts de usuário): sem isso, a página de teste nunca terminava de abrir.

## Limites da medição

- **Página sintética**, não jogos reais: sem login, sem áudio, sem Worker/WebGL. Jogos de verdade podem pesar mais
  (o ganho absoluto seria maior) ou depender de outras APIs. CPU e memória valem como **ordem de grandeza**.
- **Um PC** (16 núcleos, Windows 11) e **uma rodada por cenário**, sem repetição. O `setTimeout` variou entre rodadas
  (81% a 92% no mesmo modo), então ele só aponta a direção. Os outros números foram estáveis.
- A **cobertura por outra janela** não mudou nada; a explicação provável (a chave `disable-backgrounding-occluded-windows`)
  é uma **inferência**, não foi testada sem a chave, e não confirmamos por outro meio que a janela de cima cobria tudo.
- "Bandeja" aqui é só `win.hide()`. Não testamos tela bloqueada, monitor desligado, suspensão nem troca de usuário.
- Medimos até **9 minutos**; efeitos que só aparecem depois de horas (vazamentos, limitação mais agressiva) não foram vistos.
- O mosaico foi medido numa janela de 760×480 (contas pequenas, ~380×240). Em tela cheia a referência visível custa mais.
- Os dados brutos (um cenário por linha) estão em [`modo-economico-dados.jsonl`](modo-economico-dados.jsonl).
