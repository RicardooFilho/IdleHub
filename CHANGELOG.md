# Mudanças

Tudo que muda para quem usa o IdleHub. O histórico do IdleLive avulso, de antes de entrar no IdleHub, está em [idlelive/CHANGELOG.md](idlelive/CHANGELOG.md).

## 27/11/2026

### Novidades
- **Reconectando preso**: se o jogo ficar com a tela de "Reconectando…" por mais de 3 minutos seguidos, o IdleHub recarrega a conta sozinho. Enquanto isso, ela aparece como **Reconectando…**, sem recarregar antes da hora. Passa pelas mesmas regras de segurança das outras recargas (sem internet não recarrega, e se a conta cair 5 vezes em 10 minutos o IdleHub desiste e avisa).
- Os textos que indicam isso já vêm preenchidos nos jogos prontos e podem ser editados na tela do jogo, em **Textos de reconectando**.
- **Atalhos de teclado**, valem com a janela do IdleHub em foco, até com o cursor dentro de um jogo ou do Painel: **Ctrl + 1 a 9** vai para a conta 1 a 9 da tela, **Ctrl + Tab** e **Ctrl + Shift + Tab** vão para a próxima e a anterior, **F5** recarrega a conta aberta e **Ctrl + M** deixa todas as contas sem som (ou libera o som). A lista fica em **Configurações → Atalhos de teclado**.
- **Avisos no celular (Discord)**: cole o link de um webhook do Discord em **Configurações → Avisos no celular** e o IdleHub manda para o canal os mesmos avisos do Windows (conta que caiu, alerta disparado, sem internet…). Tem o botão **Enviar teste** para conferir. Não usa servidor nosso: o IdleHub fala direto com o Discord. O interruptor vale mesmo com as notificações do Windows desligadas.
- **Avisos no celular (Telegram)**: crie um bot no **@BotFather** (`/newbot`), cole o token em **Configurações → Avisos no celular → Telegram**, abra o seu bot e mande `/start`. O IdleHub descobre a conversa sozinho (botão **Procurar conversa**) e manda os mesmos avisos do Windows, com o título em negrito. Tem o botão **Enviar teste**. Sem servidor nosso, e o interruptor vale mesmo com as notificações do Windows desligadas.
- O link do webhook e o token do bot do Telegram ficam criptografados neste PC (arquivo `secrets.json`, protegido pelo Windows) e nunca aparecem de novo na tela, no `config.json` nem nos registros.

## 26/11/2026

### Novidades
- Os jogos não abrem mais janelas e anúncios sozinhos: só abre o que você clicou. Downloads só com clique, e programas (`.exe` e parecidos) nunca são baixados. O login com Google continua funcionando.
- Quando o PC volta da suspensão, o IdleHub recarrega as contas sozinho (uma de cada vez) para elas não ficarem paradas.
- Quando o jogo avisa que a conta foi aberta em outro lugar (outra aba, celular ou outro PC), o IdleHub não recarrega mais por cima e derruba a outra sessão: ele pausa o watchdog daquela conta por 10 minutos e avisa. A conta aparece como **Aberta em outro lugar**.
- Os textos que indicam isso já vêm preenchidos nos jogos prontos e podem ser editados na tela do jogo, em **Textos de conta aberta em outro lugar**. Recarregar a conta à mão, ou dormir e acordar, tira a pausa.
- **Sem internet**: quando a internet do PC cai, as contas ficam com o status "Sem internet" em vez de recarregar sem parar, e você recebe um aviso só (não um por conta). Quando a internet volta, elas recarregam sozinhas.
- **Jogo fora do ar**: se o site do jogo cair (erros 520 a 527 do Cloudflare ou página que não abre), a conta fica como "Jogo fora do ar" e tenta de novo sozinha, esperando cada vez mais (30 s, 1 min, 2 min… até 15 min). Você é avisado uma vez, dizendo que o problema não é do IdleHub.
- **Verificação do Cloudflare**: a tela "Verificando se você é humano" não é mais recarregada em loop. A conta fica como "Verificação" para dar tempo de ela passar sozinha; se demorar mais de 2 minutos, o IdleHub avisa para você abrir a conta e clicar na caixa.
- **Conta que cai várias vezes**: se uma conta cair 5 vezes em 10 minutos, o IdleHub para de recarregar e avisa ("Precisa de atenção"). Recarregar à mão, voltar à página inicial ou dormir e acordar a conta recomeça a contagem.

### Mudanças
- O IdleHub ganhou a mesma cara do Painel: mesmos botões, janelas, ícones, fonte Montserrat e o laranja como cor de destaque.
- Botões, ícones e fonte vêm junto com o app: a janela funciona mesmo sem internet.
- Confirmações (remover conta, excluir jogo) agora são janelas do próprio IdleHub, com o que vai acontecer explicado.
- Respostas rápidas aparecem no topo da janela (ex.: "Configurações salvas.").
- O IdleLive agora vive dentro do IdleHub: as novidades dele chegam pelas atualizações do IdleHub.

### Correções
- IdleLive aberto pelo `iniciar.bat` de dentro da pasta do IdleHub não instala mais a versão do IdleLive avulso por cima do código do IdleHub.

## 25/11/2026

### Novidades
- Primeira versão do IdleHub: várias contas de cada jogo idle numa janela só, cada uma com o próprio login.
- PokeIdle (4 contas), LoLdle (5) e One Piece Idle (2) já vêm prontos, com o link. Qualquer outro jogo de navegador entra pelo botão **+**.
- Watchdog: recarrega sozinho a conta que trava, fica em branco, cai ou passa do limite de memória, e avisa quando a conta sai do login.
- Contas dormindo: param sem gastar memória e o login continua salvo.
- Alertas: avisam quando uma palavra aparece no jogo ou quando um número passa de um valor, por notificação do Windows e na lista de **Atividade**.
- **Painel**: o IdleLive (pontos da Twitch e da Kick, votos e histórico) roda dentro do IdleHub. As contas dos jogos continuam rodando enquanto você usa o Painel.
- **Configurações → Importar dados do IdleLive** traz as contas, canais e histórico do IdleLive avulso.
- Instalador para Windows, atualização automática, ícone perto do relógio e opção de abrir junto com o Windows.

### Correções
- Login com Google dentro das contas: não pede mais chave de segurança e não é mais recusado como "navegador não seguro".
- Contas escondidas rodam a 30 FPS em vez de 5, para jogos que contam o progresso por quadro não ficarem mais lentos.
