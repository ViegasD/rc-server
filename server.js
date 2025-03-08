require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // Para gerar UUIDs
const os = require('os');
const app = express();
const PORT = 3200;
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const dns = require('node:dns');

const options = { family: 4 };

dns.lookup(os.hostname(), options, (err, addr) => {
  if (err) {
    console.error(err);
  } else {
    console.log(`IPv4 address: ${addr}`);
  }
});

function getConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST,  // External Host
        user: process.env.DB_USER,         // Nome de usuário
        password: process.env.DB_PASS, // Senha do usuário
        database: process.env.DB_BASE,    // Nome do banco de dados
        port: process.env.DB_PORT             // Porta do MySQL
    });
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
        const {token, payment_method_id, email, cpf, mac, duration, amount} = req.body;
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
            //external_reference: JSON.stringify({ mac: mac, duration: duration }), // Referência externa vinculada ao MAC Address
            
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
        insertTransaction(cpf, email, amount, mac, transactionId, brasilTime, 'enviado ao MP', duration);

        res.json(response.data);
    } catch (error) {
        console.error('Erro ao processar pagamento:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
});





// Rota para gerar pagamento Pix
app.post('/generate-pix', async (req, res) => {
    try {
        
        const [cpf, emailPix, valor, mac, duration] = req.body;
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
            //external_reference: JSON.stringify({ mac: mac, duration: duration }), // Referência externa vinculada ao MAC Address
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
        insertTransaction(cpf, emailPix, valor, mac, transactionId, brasilTime, 'enviado ao MP', duration);
        // Retorna o QR Code Pix e a Transaction ID
        res.json({ pixCode, transactionId });
    } catch (error) {
        console.error('Erro ao gerar pagamento Pix:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
});

async function getMacByTransactionId(transactionId) {
    try {
        const connection = await getConnection(); // Função para conectar ao banco de dados
        const query = `SELECT mac_address FROM transacoes WHERE transaction_id = ?`;
        
        const [rows] = await connection.execute(query, [transactionId]);

        await connection.end();

        if (rows.length > 0) {
            return rows[0].mac_address;
        } else {
            return null; // Nenhum resultado encontrado
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
        console.log("Endpoint acessado pelo Mercado Pago!");

        // Verifica se o conteúdo enviado é JSON
        if (!req.is('application/json')) {
            return res.status(400).json({ success: false, message: "Conteúdo inválido" });
        }

        const data = req.body; // Obtém os dados do payload
        console.log("JSON recebido:", data);

        // Verifica se os dados foram enviados corretamente
        if (!data) {
            console.log("Nenhum dado recebido na notificação.");
            return res.status(400).json({ success: false, message: "Nenhum dado enviado" });
        }

        // Extração de informações da notificação
        const action = data.action; // Ação realizada (ex: payment.updated)
        const notificationType = data.type; // Tipo da notificação (ex: payment)
        const paymentId = data.data?.id; // ID do pagamento

        // Logs para depuração
        console.log(`Ação: ${action}, Tipo: ${notificationType}, ID do pagamento: ${paymentId}`);

        // Validação dos dados extraídos
        if (!action || !notificationType || !paymentId) {
            console.log("Dados incompletos recebidos.");
            return res.status(400).json({ success: false, message: "Dados incompletos" });
        }

        // Processamento da notificação
        if (notificationType === "payment") {
            console.log(`Pagamento atualizado! ID: ${paymentId}`);
            const connection = getConnection();
            const query = `
                UPDATE transacoes
                SET status_pagamento = ?
                WHERE id_pagamento = ?
            `;

            connection.execute(query, [statusPagamento, idPagamento]);

            console.log(`Transação ${idPagamento} atualizada com sucesso no banco!`);

                    
            connection.end();
            try {
                const response = await fetch(`https://api.mercadopago.com/v1/payments/${idPagamento}`, {
                    method: "GET",
                    headers: {
                        "Authorization": `Bearer ${accessToken}`,
                        "Content-Type": "application/json"
                    }
                });
        
                const data = await response.json();
        
                if (data.status === "approved") {
                    console.log(`Pagamento ${idPagamento} aprovado!`);
                    const mac = getMacByTransactionId(paymentId)
                    addMacToBinding(mac, duration)

                } else {
                    console.log(`Status do pagamento ${idPagamento}: ${data.status}`);
                }
        
                res.sendStatus(200);
            } catch (error) {
                console.error("Erro ao verificar pagamento:", error);
                res.sendStatus(500);
            }






            // Aqui você pode adicionar lógica para processar o pagamento
        } else {
            console.log(`Notificação não tratada. Tipo: ${notificationType}, Ação: ${action}`);
        }

        // Responde ao Mercado Pago que a notificação foi processada
        res.status(200).json({ success: true, message: "Notificação processada com sucesso" });
    } catch (error) {
        console.error("Erro ao processar notificação:", error);
        res.status(500).json({ success: false, message: "Erro ao processar notificação" });
    }
});






// Endpoint para adicionar o MAC ao IP Binding
async function addMacToBinding(mac, duration) {
    
    
    // Validação dos campos
    if (!mac || typeof mac !== 'string' || mac.trim() === '') {
        return res.status(400).json({
            success: false,
            message: "O campo 'mac' é obrigatório e deve ser uma string válida."
        });
    }

    if (!duration || typeof duration !== 'number' || duration <= 0) {
        return res.status(400).json({
            success: false,
            message: "O campo 'duration' é obrigatório e deve ser um número maior que zero."
        });
    }

    try {
        const user = process.env.MTK_USER
        const pass = process.env.MTK_PASS
        const mikrotikIP = process.env.MTK_IP
        // Adiciona o MAC ao IP Binding
        const url = `http://${mikrotikIP}/rest/ip/hotspot/ip-binding`;
    
        const data = {
            "mac-address": mac,
            "type": "bypassed",
            "timeout": duration

        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Basic " + btoa(user + ":" + pass)
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                throw new Error(`Erro: ${response.status} - ${response.statusText}`);
            }

            const result = await response.json();
            console.log("MAC liberado com sucesso:", result);
            return result;
        } catch (error) {
            console.error("Erro ao liberar MAC:", error);
        }
    
        res.json({
            success: true,
            message: `MAC ${mac} adicionado ao IP Binding por ${duration} segundos.`
        });
    } catch (error) {
        console.error('Erro ao adicionar MAC ao IP Binding:', error);
        res.status(500).json({
            success: false,
            message: `Erro ao adicionar MAC ao IP Binding: ${error}`
        });
    }
};




function insertTransaction(cpf, email, amount, mac, transaction_id, time, status, duration) {
    // 1️⃣ Verifica se o usuário já existe pelo CPF
    const checkUserQuery = 'SELECT id FROM users WHERE cpf = ?';
    const connection = getConnection();
    connection.query(checkUserQuery, [cpf], (err, results) => {
        if (err) {
            console.error(' Erro ao verificar usuário:', err);
            return;
        }

        if (results.length === 0) {
            // 2️⃣ Usuário não existe, então cria um novo usuário
            console.log('🆕 Usuário não encontrado. Criando novo usuário...');
            const insertUserQuery = 'INSERT INTO users (cpf) VALUES (?)';

            connection.query(insertUserQuery, [cpf], (err, result) => {
                if (err) {
                    console.error(' Erro ao inserir usuário:', err);
                    return;
                }

                const userId = result.insertId;
                console.log(` Usuário criado com ID: ${userId}`);

                // 3️⃣ Se o e-mail foi fornecido, adiciona à tabela emails
                if (email) {
                    insertEmail(userId, email);
                }

                // 4️⃣ Agora que o usuário foi criado, insere a transação
                insertTransactionRow(userId, amount, mac, transaction_id, time);
            });
        } else {
            // 5️⃣ Usuário já existe, obtém o ID dele
            const userId = results[0].id;
            console.log(` Usuário encontrado com ID: ${userId}`);

            // 6️⃣ Se o e-mail foi fornecido, adiciona à tabela emails
            if (email) {
                insertEmail(userId, email);
            }

            // 7️⃣ Insere a transação associada ao usuário existente
            insertTransactionRow(userId, amount, mac, transaction_id, time, status, duration);
        }
    });
    connection.end();
}



// Função auxiliar para inserir uma transação
function insertTransactionRow(userId, amount, mac, transaction_id, time, status, duration) {
    
    const insertTransactionQuery = `
        INSERT INTO transactions (user_id, amount, mac, transaction_id, time, status, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?)`;
    const connection = getConnection();
    connection.query(insertTransactionQuery, [userId, amount, mac, transaction_id, time, status, duration], (err, result) => {
        if (err) {
            console.error(' Erro ao inserir transação:', err);
            return;
        }
        console.log(` Transação inserida com sucesso! ID: ${result.insertId}`);
    });
    connection.end();
}

// Função auxiliar para inserir o e-mail do usuário
function insertEmail(userId, email) {
    const query = 'SELECT 1 FROM emails WHERE user_id = ? AND email = ? LIMIT 1';
    const connection = getConnection();
    connection.query(query, [userId, email], (err, results) => {
        if (err) {
            console.error('Erro ao verificar e-mail:', err);
            callback(err, null);
            return;
        }

        const exists = results.length > 0; // Se houver resultados, o e-mail já existe
        
        if (exists) {
            console.log(`O e-mail ${email} já está cadastrado para o usuário ID ${userId}.`);
        } else {
            console.log(`O e-mail ${email} **NÃO** está cadastrado para o usuário ID ${userId}.`);
            const insertEmailQuery = 'INSERT INTO emails (user_id, email) VALUES (?, ?)';
            
            connection.query(insertEmailQuery, [userId, email], (err, result) => {
                if (err) {
                    console.error(' Erro ao inserir e-mail:', err);
                    return;
                }
                console.log(` E-mail ${email} inserido para o usuário ID: ${userId}`);
            });
            connection.end();
        }

        
    });

}


// Inicia o servidor
app.listen(PORT, () => {
    //console.log(`Servidor rodando em https://rcwifi-payment-server.sv1o3q.easypanel.host`);
});
