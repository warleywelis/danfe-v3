const https = require('https');
const http = require('http');

// Consulta NF-e pela chave de acesso usando o portal da SEFAZ
function fetchSefaz(chave) {
  return new Promise((resolve, reject) => {
    // Endpoint público da SEFAZ para consulta de NF-e
    const url = `https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=completa&tipoConteudo=7PhJ+gAVw2g=&nfe=${chave}`;
    
    const options = {
      hostname: 'www.nfe.fazenda.gov.br',
      path: `/portal/consultaRecaptcha.aspx?tipoConsulta=completa&tipoConteudo=7PhJ%2BgAVw2g%3D&nfe=${chave}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Tenta buscar XML via meuDANFE
function fetchMeuDanfe(chave) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'meudanfe.com.br',
      path: `/api/nfe/${chave}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://meudanfe.com.br/',
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch {
          reject(new Error('JSON inválido'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Extrai dados básicos do HTML da SEFAZ (fallback)
function parseSefazHtml(html, chave) {
  const extract = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].trim() : null;
  };

  // Detecta se a NF-e foi encontrada
  const found = html.includes('Autorizado o uso da NF-e') || html.includes('chNFe');
  if (!found && html.includes('Rejeição')) {
    return null;
  }

  const cUF = chave.substring(0, 2);
  const estados = {'11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO','21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP','41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'};

  return {
    sefaz: true,
    nfe: {
      ide: {
        nNF: parseInt(chave.slice(25, 34)) || 0,
        dEmi: new Date().toISOString(),
        natOp: extract(/Natureza da Opera[çc][ãa]o[^>]*>[^<]*<[^>]+>([^<]+)/) || 'Operação fiscal',
        cUF: cUF,
        ufDesc: estados[cUF] || 'BR',
      },
      emit: {
        xNome: extract(/Emitente[\s\S]{0,200}?Raz[ãa]o Social[^>]*>[^<]*<[^>]+>([^<]+)/) || extract(/([A-Z\s]{5,50} LTDA|[A-Z\s]{5,50} S\.A\.|[A-Z\s]{5,50} EIRELI)/) || 'Emitente',
        CNPJ: chave.slice(6, 20),
        enderEmit: { xMun: 'Consulte o DANFE', UF: estados[cUF] || '' },
      },
      dest: {
        xNome: 'Destinatário',
        enderDest: { xMun: '', UF: '' },
      },
      det: [],
      total: { ICMSTot: { vNF: 0, vProd: 0, vFrete: 0, vDesc: 0, vICMS: 0 } },
      transp: { modFrete: 9 },
      _partial: true,
    }
  };
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { chave } = req.query;

  if (!chave || !/^\d{44}$/.test(chave)) {
    return res.status(400).json({ error: 'Chave inválida. Deve ter exatamente 44 dígitos.' });
  }

  // 1. Tenta meuDANFE primeiro
  try {
    const data = await fetchMeuDanfe(chave);
    if (data && (data.nfe || data.emit)) {
      return res.status(200).json({ source: 'meudanfe', ...data });
    }
  } catch (e) {
    // continua para próxima fonte
  }

  // 2. Tenta SEFAZ
  try {
    const html = await fetchSefaz(chave);
    const parsed = parseSefazHtml(html, chave);
    if (parsed) {
      return res.status(200).json({ source: 'sefaz', ...parsed });
    }
  } catch (e) {
    // continua
  }

  // 3. Retorna dados básicos extraídos da própria chave
  const cUF = chave.substring(0, 2);
  const estados = {'11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO','21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP','41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'};
  
  return res.status(200).json({
    source: 'chave',
    _partial: true,
    nfe: {
      ide: {
        nNF: parseInt(chave.slice(25, 34)) || 0,
        dEmi: `20${chave.slice(2,4)}-${chave.slice(4,6)}-01T00:00:00-03:00`,
        natOp: 'Consulte o DANFE para detalhes',
        cUF,
        ufDesc: estados[cUF] || '',
      },
      emit: {
        xNome: 'CNPJ: ' + chave.slice(6, 20).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
        CNPJ: chave.slice(6, 20),
        enderEmit: { xMun: estados[cUF] || '', UF: estados[cUF] || '' },
      },
      dest: { xNome: '—', enderDest: { xMun: '', UF: '' } },
      det: [],
      total: { ICMSTot: { vNF: 0, vProd: 0, vFrete: 0, vDesc: 0, vICMS: 0 } },
      transp: { modFrete: 9 },
    }
  });
};
