// Backend WebSocket com Durable Objects para Rachacuca Casino
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.jogadores = [];
    this.jogoAndamento = false;
    this.rodadaAtiva = false;
    this.numeroRodada = 0;
    this.poteAcumulado = 0;
    this.alvoAtual = 0;
    this.mensagensChat = [];
    this.modoDesespero = false;
    this.maxRodadas = 15;
  }

  async fetch(request) {
    const [client, server] = new WebSocketPair();
    server.accept();

    server.addEventListener('message', (msg) => {
      try {
        const data = JSON.parse(msg.data);
        this.handleMessage(data, server);
      } catch (e) {
        console.error('Erro ao processar mensagem:', e);
      }
    });

    server.addEventListener('close', () => {
      this.handleDisconnect(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  handleMessage(data, socket) {
    switch(data.type) {
      case 'JOIN':
        this.handleJoin(data, socket);
        break;
      case 'START':
        this.handleStart(socket);
        break;
      case 'JOGADA':
        this.handleJogada(data);
        break;
      case 'DESISTIR':
        this.handleDesistir(data);
        break;
      case 'CHAT':
        this.handleChat(data);
        break;
      case 'TRANSFERIR':
        this.handleTransferencia(data);
        break;
      case 'ENCERRAR_DESESPERO':
        this.encerrarDesespero(socket);
        break;
    }
  }

  async handleJoin(data, socket) {
    const nome = (data.nome || '').trim();
    
    if (!nome || nome.length < 2 || nome.length > 20) {
      socket.send(JSON.stringify({type: 'ERRO', msg: 'Nome deve ter entre 2 e 20 caracteres'}));
      return;
    }

    if (!/^[a-zA-Z0-9_\- ]+$/.test(nome)) {
      socket.send(JSON.stringify({type: 'ERRO', msg: 'Use apenas letras, números, _ e -'}));
      return;
    }

    const existente = this.jogadores.find(j => j.nome === nome && !j.desconectado);
    if (existente) {
      socket.send(JSON.stringify({type: 'ERRO', msg: 'Nome já em uso'}));
      return;
    }

    const ativos = this.jogadores.filter(j => !j.desconectado);
    if (ativos.length >= 8) {
      socket.send(JSON.stringify({type: 'ERRO', msg: 'Sala cheia (máx 8)'}));
      socket.close();
      return;
    }

    const isHost = ativos.length === 0;
    const novo = {
      nome,
      socket,
      fichas: 500,
      pronto: false,
      eliminado: false,
      isHost,
      desconectado: false,
      resultado: null,
      distancia: 999,
      tempo: 0,
      pularProxima: false,
      entradaEm: new Date().toISOString()
    };

    this.jogadores.push(novo);
    socket.send(JSON.stringify({type: 'INFO_PLAYER', isHost}));
    
    this.adicionarMensagemSistema(`🎰 ${nome} entrou na sala!`);
    
    // REGISTRAR NO HISTÓRICO GLOBAL
    await this.registrarJogadorNoHistorico(nome);
    
    this.broadcastState();
    this.broadcastChat();
  }

  async registrarJogadorNoHistorico(nomeJogador) {
    try {
      // Envia para o Histórico Global
      const historicoId = this.env.HistoricoDO.idFromName('historico-global');
      const historicoObj = this.env.HistoricoDO.get(historicoId);
      
      await historicoObj.fetch(new Request('https://dummy/registrar', {
        method: 'POST',
        body: JSON.stringify({
          tipo: 'jogador',
          nome: nomeJogador,
          timestamp: new Date().toISOString()
        })
      }));
    } catch (e) {
      console.error('Erro ao registrar jogador:', e);
    }
  }

  handleDisconnect(socket) {
    const jogador = this.jogadores.find(j => j.socket === socket);
    if (!jogador) return;

    jogador.desconectado = true;
    jogador.desconectadoEm = Date.now();

    this.adicionarMensagemSistema(`👋 ${jogador.nome} saiu da sala.`);

    if (jogador.isHost) {
      const novoHost = this.jogadores.find(j => !j.desconectado && j !== jogador);
      if (novoHost) {
        novoHost.isHost = true;
        try {
          novoHost.socket.send(JSON.stringify({type: 'INFO_PLAYER', isHost: true}));
        } catch(e) {}
      }
    }

    this.broadcastState();
    this.broadcastChat();

    setTimeout(() => {
      this.jogadores = this.jogadores.filter(j => 
        !j.desconectado || (Date.now() - (j.desconectadoEm || 0)) < 300000
      );
    }, 5000);
  }

  async handleStart(socket) {
    const jogador = this.jogadores.find(j => j.socket === socket);
    if (!jogador || !jogador.isHost) {
      socket.send(JSON.stringify({type: 'ERRO', msg: 'Apenas host pode iniciar'}));
      return;
    }

    const ativos = this.jogadores.filter(j => !j.desconectado && !j.eliminado);
    if (ativos.length < 2) {
      socket.send(JSON.stringify({type: 'ERRO', msg: 'Mínimo 2 jogadores'}));
      return;
    }

    this.jogoAndamento = true;
    this.numeroRodada = 0;
    this.poteAcumulado = 0;

    this.jogadores.forEach(j => {
      if (!j.desconectado) {
        j.fichas = 500;
        j.eliminado = false;
        j.pronto = false;
        j.pularProxima = false;
      }
    });

    // REGISTRAR SALA INICIADA NO HISTÓRICO
    await this.registrarSalaNoHistorico();

    this.adicionarMensagemSistema('🎮 O jogo começou! Boa sorte a todos!');
    this.broadcastChat();

    setTimeout(() => {
      this.iniciarNovaRodada();
    }, 1000);
  }

  async registrarSalaNoHistorico() {
    try {
      const historicoId = this.env.HistoricoDO.idFromName('historico-global');
      const historicoObj = this.env.HistoricoDO.get(historicoId);
      
      const jogadoresAtivos = this.jogadores
        .filter(j => !j.desconectado)
        .map(j => j.nome);
      
      await historicoObj.fetch(new Request('https://dummy/registrar', {
        method: 'POST',
        body: JSON.stringify({
          tipo: 'sala',
          jogadores: jogadoresAtivos,
          totalJogadores: jogadoresAtivos.length,
          timestamp: new Date().toISOString()
        })
      }));
    } catch (e) {
      console.error('Erro ao registrar sala:', e);
    }
  }

  iniciarNovaRodada() {
    this.rodadaAtiva = true;
    this.numeroRodada++;

    const vivos = this.jogadores.filter(j => !j.eliminado && !j.desconectado);
    
    if (this.numeroRodada > this.maxRodadas || (vivos.length <= 1 && this.numeroRodada > 1)) {
      this.finalizarJogo();
      return;
    }

    if (this.numeroRodada > 1 && (this.numeroRodada === 5 || this.numeroRodada === 10 || this.numeroRodada === 15)) {
      this.iniciarSalaDesespero();
      return;
    }

    this.alvoAtual = Math.floor(Math.random() * 100) + 1;

    const baralho = [];
    for (let i = 0; i < 4; i++) {
      for (let n = 1; n <= 13; n++) {
        baralho.push(n);
      }
    }
    this.shuffle(baralho);

    vivos.forEach(j => {
      if (j.pularProxima) {
        j.pronto = true;
        j.resultado = 'PULOU';
        j.distancia = 9999;
        j.pularProxima = false;
        
        try {
          j.socket.send(JSON.stringify({
            type: 'ERRO',
            msg: '⚠️ Você pulou esta rodada por ter transferido fichas!'
          }));
        } catch(e) {}
      } else {
        j.pronto = false;
        j.resultado = null;
        j.distancia = 999;
        j.tempo = 0;
        
        const mao = [
          baralho.pop(), 
          baralho.pop(), 
          baralho.pop(), 
          baralho.pop()
        ];

        try {
          j.socket.send(JSON.stringify({
            type: 'SUA_MAO',
            cartas: mao,
            alvo: this.alvoAtual,
            rodada: this.numeroRodada,
            fichas: j.fichas
          }));
        } catch(e) {}
      }
    });

    this.broadcastState();

    if (this.timerRodada) clearTimeout(this.timerRodada);
    this.timerRodada = setTimeout(() => {
      this.finalizarRodada();
    }, 60000);
  }

  iniciarSalaDesespero() {
    this.modoDesespero = true;
    this.rodadaAtiva = false;

    this.adicionarMensagemSistema(`🔥 RODADA ${this.numeroRodada} - SALA DO DESESPERO! 🔥`);
    this.adicionarMensagemSistema('💀 O jogador com menos fichas será eliminado!');
    this.adicionarMensagemSistema('💰 Você pode transferir fichas, mas pulará a próxima rodada!');

    this.broadcast({
      type: 'INICIAR_DESESPERO',
      rodada: this.numeroRodada
    });

    this.broadcastChat();
  }

  encerrarDesespero(socket) {
    const jogador = this.jogadores.find(j => j.socket === socket);
    if (!jogador || !jogador.isHost) return;

    if (!this.modoDesespero) return;

    this.modoDesespero = false;

    const vivos = this.jogadores.filter(j => !j.eliminado && !j.desconectado);
    if (vivos.length > 1) {
      vivos.sort((a, b) => a.fichas - b.fichas);
      const eliminado = vivos[0];
      eliminado.eliminado = true;
      this.poteAcumulado += eliminado.fichas;
      eliminado.fichas = 0;

      this.adicionarMensagemSistema(`💀 ${eliminado.nome} foi ELIMINADO com ${vivos[0].fichas} fichas!`);
      this.adicionarMensagemSistema(`💰 ${this.poteAcumulado} fichas foram para o pote acumulado!`);
    }

    this.broadcastChat();
    this.broadcastState();

    setTimeout(() => {
      this.iniciarNovaRodada();
    }, 3000);
  }

  handleJogada(data) {
    const jogador = this.jogadores.find(j => j.nome === data.nome);
    if (!jogador || !this.rodadaAtiva || jogador.eliminado || jogador.pronto) return;

    jogador.pronto = true;
    jogador.resultado = data.valor;
    jogador.distancia = Math.abs(this.alvoAtual - data.valor);
    jogador.tempo = data.tempo || 60;

    this.broadcastState();
    this.verificarFimRodada();
  }

  handleDesistir(data) {
    const jogador = this.jogadores.find(j => j.nome === data.nome);
    if (!jogador || !this.rodadaAtiva || jogador.eliminado) return;

    jogador.pronto = true;
    jogador.resultado = 'DESISTIU';
    jogador.distancia = 9999;
    jogador.tempo = 999;

    this.broadcastState();
    this.verificarFimRodada();
  }

  handleChat(data) {
    const nome = data.nome;
    const mensagem = (data.mensagem || '').trim();

    if (!mensagem || mensagem.length > 100) return;

    this.mensagensChat.push({
      nome: nome,
      texto: mensagem,
      sistema: false,
      timestamp: Date.now()
    });

    if (this.mensagensChat.length > 50) {
      this.mensagensChat.shift();
    }

    this.broadcastChat();
  }

  handleTransferencia(data) {
    const de = this.jogadores.find(j => j.nome === data.de);
    const para = this.jogadores.find(j => j.nome === data.para);
    const valor = parseInt(data.valor);

    if (!de || !para || !valor) return;
    if (de.eliminado || para.eliminado) return;
    if (de.fichas < valor) {
      try {
        de.socket.send(JSON.stringify({
          type: 'ERRO',
          msg: 'Você não tem fichas suficientes!'
        }));
      } catch(e) {}
      return;
    }

    de.fichas -= valor;
    para.fichas += valor;
    de.pularProxima = true;

    this.adicionarMensagemSistema(`💸 ${de.nome} transferiu ${valor} fichas para ${para.nome}!`);
    this.adicionarMensagemSistema(`⚠️ ${de.nome} pulará a próxima rodada!`);

    this.broadcastChat();
    this.broadcastState();
  }

  adicionarMensagemSistema(texto) {
    this.mensagensChat.push({
      texto: texto,
      sistema: true,
      timestamp: Date.now()
    });

    if (this.mensagensChat.length > 50) {
      this.mensagensChat.shift();
    }
  }

  verificarFimRodada() {
    const jogando = this.jogadores.filter(j => !j.eliminado && !j.desconectado);
    if (jogando.length > 0 && jogando.every(j => j.pronto)) {
      if (this.timerRodada) clearTimeout(this.timerRodada);
      
      setTimeout(() => {
        this.finalizarRodada();
      }, 500);
    }
  }

  finalizarRodada() {
    if (!this.rodadaAtiva) return;
    this.rodadaAtiva = false;

    const jogando = this.jogadores.filter(j => 
      !j.eliminado && 
      !j.desconectado && 
      j.resultado !== null && 
      j.resultado !== 'DESISTIU' &&
      j.resultado !== 'PULOU'
    );
    
    if (jogando.length === 0) {
      setTimeout(() => {
        this.iniciarNovaRodada();
      }, 2000);
      return;
    }

    const vencedor = jogando.reduce((prev, curr) => {
      if (prev.distancia < curr.distancia) return prev;
      if (curr.distancia < prev.distancia) return curr;
      return prev.tempo < curr.tempo ? prev : curr;
    });

    let premio = 0;
    if (vencedor.tempo <= 20) premio = 100;
    else if (vencedor.tempo <= 30) premio = 80;
    else if (vencedor.tempo <= 40) premio = 30;
    else if (vencedor.tempo <= 50) premio = -15;
    else premio = -30;

    vencedor.fichas += premio;

    this.broadcast({
      type: 'FIM_RODADA',
      vencedor: vencedor.nome,
      valor: vencedor.resultado,
      distancia: vencedor.distancia,
      premio,
      msgExtra: ''
    });

    this.adicionarMensagemSistema(`🏆 ${vencedor.nome} venceu a rodada ${this.numeroRodada}! (${premio >= 0 ? '+' : ''}${premio} fichas)`);
    this.broadcastChat();

    setTimeout(() => {
      this.iniciarNovaRodada();
    }, 6000);
  }

  finalizarJogo() {
    this.jogoAndamento = false;
    this.rodadaAtiva = false;
    
    const vivos = this.jogadores.filter(j => !j.eliminado && !j.desconectado);
    
    if (vivos.length === 0) {
      this.adicionarMensagemSistema('🎰 Jogo finalizado! Não há vencedores.');
      this.broadcastChat();
      return;
    }

    vivos.sort((a, b) => b.fichas - a.fichas);
    const campeao = vivos[0];
    campeao.fichas += this.poteAcumulado;

    const ranking = this.jogadores
      .filter(j => !j.desconectado)
      .sort((a, b) => b.fichas - a.fichas)
      .map((j, i) => ({
        posicao: i + 1,
        nome: j.nome,
        fichas: j.fichas,
        eliminado: j.eliminado
      }));

    this.broadcast({
      type: 'FIM_JOGO',
      vencedor: campeao.nome,
      fichas: campeao.fichas,
      poteAcumulado: this.poteAcumulado,
      ranking
    });

    this.adicionarMensagemSistema(`🏆 ${campeao.nome} é o GRANDE CAMPEÃO com ${campeao.fichas} fichas!`);
    this.broadcastChat();
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  broadcastState() {
    const lista = this.jogadores
      .filter(j => !j.desconectado)
      .map(j => ({
        nome: j.nome,
        fichas: j.fichas,
        pronto: j.pronto,
        eliminado: j.eliminado,
        isHost: j.isHost
      }));

    this.broadcast({
      type: 'LISTA', 
      lista,
      rodada: this.numeroRodada,
      maxRodadas: this.maxRodadas
    });
  }

  broadcastChat() {
    this.broadcast({
      type: 'CHAT_UPDATE',
      mensagens: this.mensagensChat.slice(-30)
    });
  }

  broadcast(msg) {
    this.jogadores.forEach(j => {
      if (!j.desconectado) {
        try {
          j.socket.send(JSON.stringify(msg));
        } catch (e) {
          console.error('Erro ao enviar mensagem:', e);
        }
      }
    });
  }
}

// CLASSE PARA RECORDES GLOBAIS
export class RecordesDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (request.method === 'GET' && url.pathname === '/recordes') {
      const recordes = await this.state.storage.get('recordesSolo') || [];
      return new Response(JSON.stringify(recordes), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/recordes') {
      try {
        const body = await request.json();
        const { nome, fichas } = body;
        
        if (!nome || typeof fichas !== 'number') {
          return new Response(JSON.stringify({ erro: 'Dados inválidos' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        let recordes = await this.state.storage.get('recordesSolo') || [];
        
        recordes.push({
          nome: nome.substring(0, 20),
          fichas: fichas,
          data: new Date().toISOString()
        });
        
        recordes.sort((a, b) => b.fichas - a.fichas);
        recordes = recordes.slice(0, 10);
        
        await this.state.storage.put('recordesSolo', recordes);
        
        return new Response(JSON.stringify({ sucesso: true, recordes }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ erro: 'Erro ao processar' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
}

// NOVA CLASSE PARA HISTÓRICO
export class HistoricoDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // GET /historico - Retorna histórico completo
    if (request.method === 'GET' && url.pathname === '/historico') {
      const jogadores = await this.state.storage.get('jogadores') || [];
      const salas = await this.state.storage.get('salas') || [];
      
      return new Response(JSON.stringify({ jogadores, salas }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // POST /registrar - Registra novo jogador ou sala
    if (request.method === 'POST' && url.pathname === '/registrar') {
      try {
        const body = await request.json();
        
        if (body.tipo === 'jogador') {
          let jogadores = await this.state.storage.get('jogadores') || [];
          
          // Verifica se jogador já existe
          const existe = jogadores.find(j => j.nome === body.nome);
          if (!existe) {
            jogadores.push({
              nome: body.nome,
              primeiraVez: body.timestamp,
              totalPartidas: 1
            });
          } else {
            existe.totalPartidas++;
            existe.ultimaVez = body.timestamp;
          }
          
          await this.state.storage.put('jogadores', jogadores);
        }
        
        if (body.tipo === 'sala') {
          let salas = await this.state.storage.get('salas') || [];
          
          salas.push({
            jogadores: body.jogadores,
            totalJogadores: body.totalJogadores,
            timestamp: body.timestamp
          });
          
          // Manter apenas últimas 100 salas
          if (salas.length > 100) {
            salas = salas.slice(-100);
          }
          
          await this.state.storage.put('salas', salas);
        }
        
        return new Response(JSON.stringify({ sucesso: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ erro: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ROTA PARA RECORDES
    if (url.pathname === '/recordes' || url.pathname === '/recordes/') {
      const id = env.RecordesDO.idFromName('recordes-globais');
      return env.RecordesDO.get(id).fetch(request);
    }

    // ROTA PARA HISTÓRICO
    if (url.pathname === '/historico' || url.pathname === '/historico/') {
      const id = env.HistoricoDO.idFromName('historico-global');
      return env.HistoricoDO.get(id).fetch(request);
    }

    // ROTA PARA WEBSOCKET
    if (request.headers.get('Upgrade') === 'websocket') {
      const sala = url.searchParams.get('sala') || 'padrao';
      const salaNormalizada = sala.substring(0, 50).replace(/[^a-zA-Z0-9\-_]/g, '');
      const id = env.RoomDO.idFromName(salaNormalizada);
      return env.RoomDO.get(id).fetch(request);
    }

    return new Response(`
      🧮 Rachacuca Casino Backend v2.4
      
      Status: Online
      Modo: WebSocket + Recordes Globais + Histórico
      
      Endpoints:
      - GET /recordes - Recordes do modo solo
      - POST /recordes - Salvar novo recorde
      - GET /historico - Histórico de jogadores e salas
      - WebSocket: wss://rachacuca-backend.esdrasjulio.workers.dev/?sala=NOME
    `, {
      headers: { 
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};