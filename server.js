require('dotenv').config();
const fetch = require("node-fetch");

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // Para gerar UUIDs
const os = require('os');
const app = express();
const PORT = 3200;
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const dns = require('node:dns');
const cors = require('cors');
const net = require("net");
const crypto = require("crypto");

app.use(cors({
    origin: '*', // Permite qualquer origem (Ajuste para maior segurança se necessário)
    methods: ['GET', 'POST'], // Métodos permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeçalhos permitidos
}));

const options = { family: 4 };

dns.lookup(os.hostname(), options, (err, addr) => {
  if (err) {
    console.error(err);
  } else {
    console.log(`IPv4 address: ${addr}`);
  }
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_BASE,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
});

async function executeQuery(query, values) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute(query, values);
        return rows;
    } catch (error) {
        console.error("Erro na query MySQL:", error);
        throw error;
    } finally {
        connection.release();
    }
}





app.use(cors());
app.use(express.json());

app.post('/get-payment-methods', async (req, res) => {
    try {
        const { bin } = req.body;
        console.log(`BIN recebido: ${bin}`);

        const response = await axios.get(`https://api.mercadopago.com/v1/payment_methods/search?bin=${bin}&site_id=MLB`, {
            headers: {
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
            }
        });

        console.log('Resposta da API do Mercado Pago:', response.data);

        // Filtra os resultados para encontrar cartões de crédito ou débito com status ativo
        const paymentMethod = response.data.results.find(method =>
            (method.payment_type_id === 'credit_card' || method.payment_type_id === 'debit_card') &&
            method.status === 'active'
        );

        if (paymentMethod) {
            res.json({ paymentMethodId: paymentMethod.id });
        } else {
            res.status(404).json({ error: 'Nenhuma bandeira de cartão válida encontrada' });
        }
    } catch (error) {
        console.error('Erro ao buscar a bandeira do cartão:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Erro ao buscar a bandeira do cartão' });
    }
});





// Rota para processar pagamento (Crédito e Débito)
app.post('/process-payment', async (req, res) => {
    try {
        const idempotencyKey = uuidv4();
        console.log('Requisição recebida para pagamento:', req.body);
        const {token, payment_method_id, email, cpf, ip, duration, amount} = req.body;
        const data = {
            transaction_amount: amount,
            description: 'Descrição do produto',
            installments: 1,
            token: token,
            payment_method_id: payment_method_id, // Certifique-se de que este campo está sendo passado corretamente
            payer: {
                email: email,
                identification: {
                    type: 'CPF',
                    number: cpf
                }
            },
            //external_reference: JSON.stringify({ ip: ip, duration: duration }), // Referência externa vinculada ao MAC Address
            
        };
        const response = await axios.post('https://api.mercadopago.com/v1/payments', data, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                'X-Idempotency-Key': idempotencyKey
            }
        });
        const transactionId = response.data.id;
        console.log(transactionId)
        const now = new Date();
        const formattedTime = new Intl.DateTimeFormat('pt-BR', { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit', 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit', 
            hour12: false,
            timeZone: 'America/Sao_Paulo' // Define o fuso horário do Brasil
        }).format(now).replace(',', '');

        // Ajustar o formato para MySQL (YYYY-MM-DD HH:MM:SS)
        const [date, time] = formattedTime.split(' ');
        const [day, month, year] = date.split('/');
        const brasilTime = `${year}-${month}-${day} ${time}`;
        console.log('Resposta da API do Mercado Pago:', response.data);
        insertTransaction(cpf, email, amount, ip, transactionId, brasilTime, 'enviado ao MP', duration);

        res.json(response.data);
    } catch (error) {
        console.error('Erro ao processar pagamento:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
});





// Rota para gerar pagamento Pix
app.post('/generate-pix', async (req, res) => {
    try {
        
        const { cpf, emailPix, valor, ip, duration } = req.body;
        const idempotencyKey = uuidv4();

        const paymentData = {
            transaction_amount: valor, // Valor do pagamento em reais (ex: 100 para R$100,00)
            description: 'Pagamento via Pix',
            payment_method_id: 'pix',
            payer: {
                email: emailPix,
                first_name: ' ',
                last_name: ' ',
                identification: {
                    type: 'CPF',
                    number: cpf,
                },
            },
            //external_reference: JSON.stringify({ ip: ip, duration: duration }), // Referência externa vinculada ao MAC Address
        };

        console.log('Requisição recebida para pagamento Pix:', paymentData);

        // Faz a requisição para a API do Mercado Pago
        const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                'X-Idempotency-Key': idempotencyKey,
            },
        });

        const pixCode = response.data.point_of_interaction.transaction_data.qr_code;
        const transactionId = response.data.id; // Obtém a transaction ID da resposta
        const now = new Date();
        const formattedTime = new Intl.DateTimeFormat('pt-BR', { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit', 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit', 
            hour12: false,
            timeZone: 'America/Sao_Paulo' // Define o fuso horário do Brasil
        }).format(now).replace(',', '');

        // Ajustar o formato para MySQL (YYYY-MM-DD HH:MM:SS)
        const [date, time] = formattedTime.split(' ');
        const [day, month, year] = date.split('/');
        const brasilTime = `${year}-${month}-${day} ${time}`;
        insertTransaction(cpf, emailPix, valor, ip, transactionId, brasilTime, 'enviado ao MP', duration);
        // Retorna o QR Code Pix e a Transaction ID
        res.json({ pixCode, transactionId });
    } catch (error) {
        console.error('Erro ao gerar pagamento Pix:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
});

async function getMacByTransactionId(transactionId) {
    try {
        const rows = await executeQuery(
            `SELECT ip FROM transactions WHERE transaction_id = ?`, 
            [transactionId]
        );

        if (rows.length > 0) {
            return rows[0].ip; // Corrigido para 'ip' ao invés de 'ip_address'
        } else {
            return null; // Retorna null se não encontrar um MAC
        }
    } catch (error) {
        console.error("Erro ao buscar MAC:", error);
        return null;
    }
}




// Middleware para processar JSON
app.use(bodyParser.json());
// Endpoint para receber notificações do Mercado Pago
app.post('/payment-notification', async (req, res) => {
    try {
        console.log("🔔 Notificação do Mercado Pago recebida!");

        // Verifica se o conteúdo enviado é JSON
        if (!req.is('application/json')) {
            return res.status(400).json({ success: false, message: "Conteúdo inválido" });
        }

        const { action, type, data } = req.body;
        const paymentId = data?.id;

        // Validação básica dos dados recebidos
        if (!action || !type || !paymentId) {
            console.log(" Dados incompletos recebidos na notificação.");
            return res.status(400).json({ success: false, message: "Dados incompletos" });
        }

        console.log(`🔹 Ação: ${action}, Tipo: ${type}, ID do pagamento: ${paymentId}`);

        // Processamento apenas para notificações de pagamento
        if (type === "payment") {
            console.log(` Buscando status do pagamento no Mercado Pago: ${paymentId}`);

            // Busca o status do pagamento na API do Mercado Pago
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: {
                    "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`
                }
            });

            const paymentData = response.data;
            const statusPagamento = paymentData.status;

            console.log(` Status do pagamento ${paymentId}: ${statusPagamento}`);

            // Atualiza o status da transação no banco de dados
            await executeQuery(
                `UPDATE transactions SET status = ? WHERE transaction_id = ?`,
                [statusPagamento, paymentId]
            );
            


            console.log(` Transação ${paymentId} atualizada no banco de dados.`);

            // Se o pagamento foi aprovado, libera o MAC
            if (statusPagamento === "approved") {
                console.log(`🎉 Pagamento aprovado! Buscando MAC Address...`);

                const ip = await getMacByTransactionId(paymentId);
                const duration = 3600; // Duração padrão (1 hora)

                if (ip) {
                    await addIpToBinding(ip, duration);
                    console.log(` IP ${ip} liberado no MikroTik por ${duration} segundos.`);
                } else {
                    console.log(` Nenhum IP encontrado para a transação ${paymentId}.`);
                }
            }
        } else {
            console.log(` Notificação ignorada. Tipo: ${type}, Ação: ${action}`);
        }

        // Responde ao Mercado Pago que a notificação foi processada com sucesso
        res.status(200).json({ success: true, message: "Notificação processada com sucesso" });

    } catch (error) {
        console.error(" Erro ao processar notificação:", error);
        res.status(500).json({ success: false, message: "Erro ao processar notificação" });
    }
});








// Função para converter duration (ex: "30m", "10s", "3h") para "HH:MM:SS"
function convertDurationToHHMMSS(duration) {
    const match = duration.match(/^(\d+)([smh])$/);
    if (!match) throw new Error(`Formato de duração inválido: ${duration}`);

    let time = parseInt(match[1]);
    let unit = match[2];

    let hours = 0, minutes = 0, seconds = 0;
    if (unit === "s") seconds = time;
    else if (unit === "m") minutes = time;
    else if (unit === "h") hours = time;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Função para realizar uma requisição com tentativas automáticas
async function fetchWithRetry(url, options, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            return response;
        } catch (error) {
            attempt++;
            console.error(`❌ Erro na tentativa ${attempt}/${maxRetries}: ${error.message}`);
            if (attempt === maxRetries) throw error;
            await new Promise(res => setTimeout(res, 2000)); // Espera 2s antes de tentar novamente
        }
    }
}

// Função para realizar uma requisição com tentativas automáticas
async function fetchWithRetry(url, options, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            return response;
        } catch (error) {
            attempt++;
            console.error(`❌ Erro na tentativa ${attempt}/${maxRetries}: ${error.message}`);
            if (attempt === maxRetries) throw error;
            await new Promise(res => setTimeout(res, 2000)); // Espera 2s antes de tentar novamente
        }
    }
}

async function addIpBindingWithTimeout(ip, duration = "30m") {
    try {
        const user = process.env.MTK_USER || "admin";
        const pass = process.env.MTK_PASS || "admin";
        const mikrotikIP = process.env.MTK_IP || "192.168.0.200";

        const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

        console.log(`Adicionando IP ${ip} à lista de bindings...`);

        // 1️⃣ Criar IP Binding
        const bindingPayload = { "address": ip, "type": "regular", "comment": `Remover em ${duration}` };
        await fetchWithRetry(`http://${mikrotikIP}/rest/ip/hotspot/ip-binding`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Authorization": authHeader },
            body: JSON.stringify(bindingPayload)
        });

        console.log(`✅ IP ${ip} adicionado com sucesso.`);

        // 2️⃣ Criar script no MikroTik para remover o IP após o tempo especificado
        const scriptName = `remover_ip_${ip.replace(/\./g, "_")}`;
        const scriptPayload = {
            "name": scriptName,
            "source": `:log info \"Removendo IP ${ip}\"; :local id [/ip hotspot ip-binding find where address=\"${ip}\"]; :if (\$id != \"\") do={ /ip hotspot ip-binding remove \$id; :log info \"IP ${ip} removido com sucesso\"; } else={ :log info \"IP ${ip} não encontrado\"; }; /system script remove [find name=\"${scriptName}\"]`
        };

        await fetchWithRetry(`http://${mikrotikIP}/rest/system/script`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Authorization": authHeader },
            body: JSON.stringify(scriptPayload)
        });

        console.log(`✅ Script de remoção criado: ${scriptName}`);

        // 3️⃣ Criar Scheduler para rodar o script após o tempo determinado (sem conversão de tempo)
        const schedulerPayload = {
            "name": scriptName,
            "interval": duration,  // Mantém o formato aceito pelo MikroTik
            "on-event": `/system script run ${scriptName}; /system scheduler remove [find name=\"${scriptName}\"]`
        };

        await fetchWithRetry(`http://${mikrotikIP}/rest/system/scheduler`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Authorization": authHeader },
            body: JSON.stringify(schedulerPayload)
        });

        console.log(`✅ Scheduler criado para rodar ${scriptName} após ${duration}`);

        return { success: true };

    } catch (error) {
        console.error("❌ Erro final:", error);
        return { success: false, error: error.message };
    }
}







async function insertTransaction(cpf, email, amount, ip, transaction_id, time, status, duration) {
    try {
        // Verifica se o usuário já existe pelo CPF
        const userResults = await executeQuery('SELECT id FROM users WHERE cpf = ?', [cpf]);
        let userId;

        if (userResults.length === 0) {
            // Usuário não existe, cria um novo
            const insertUserResult = await executeQuery('INSERT INTO users (cpf) VALUES (?)', [cpf]);
            userId = insertUserResult.insertId;
            console.log(`Usuário criado com ID: ${userId}`);

            // Adiciona o e-mail se fornecido
            if (email) {
                await insertEmail(userId, email);
            }
        } else {
            userId = userResults[0].id;
            console.log(`Usuário encontrado com ID: ${userId}`);

            // Adiciona o e-mail se fornecido
            if (email) {
                await insertEmail(userId, email);
            }
        }

        // Insere a transação
        await executeQuery(
            'INSERT INTO transactions (user_id, amount, ip, transaction_id, time, status, duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, amount, ip, transaction_id, time, status, duration]
        );

        console.log(`Transação inserida com sucesso para o usuário ID: ${userId}`);
    } catch (error) {
        console.error('Erro ao inserir transação:', error);
    }
}



// Função auxiliar para inserir o e-mail do usuário
async function insertEmail(userId, email) {
    try {
        const emailExists = await executeQuery(
            'SELECT 1 FROM emails WHERE user_id = ? AND email = ? LIMIT 1',
            [userId, email]
        );

        if (emailExists.length > 0) {
            console.log(`O e-mail ${email} já está cadastrado para o usuário ID ${userId}.`);
        } else {
            await executeQuery(
                'INSERT INTO emails (user_id, email) VALUES (?, ?)',
                [userId, email]
            );
            console.log(`E-mail ${email} inserido para o usuário ID: ${userId}`);
        }

    } catch (error) {
        console.error('Erro ao inserir/verificar e-mail:', error);
    }
}

// Inicia o servidor
app.listen(PORT, () => {
    //console.log(`Servidor rodando em https://rcwifi-payment-server.sv1o3q.easypanel.host`);
});
