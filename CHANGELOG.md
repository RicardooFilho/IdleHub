# Mudanças

Tudo que muda para quem usa o IdleHub. O histórico do IdleLive avulso, de antes de entrar no IdleHub, está em [idlelive/CHANGELOG.md](idlelive/CHANGELOG.md).

## 26/11/2026

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
