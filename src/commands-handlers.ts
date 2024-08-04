import { CHAIN, isTelegramUrl, toUserFriendlyAddress, UserRejectsError } from '@tonconnect/sdk';
import { bot } from './bot';
import { getWallets, getWalletInfo } from './ton-connect/wallets';
import QRCode from 'qrcode';
import TelegramBot from 'node-telegram-bot-api';
import { Telegraf, Context, Markup } from 'telegraf';
import { getConnector } from './ton-connect/connector';
import { addTGReturnStrategy, buildUniversalKeyboard, pTimeout, pTimeoutException } from './utils';

let newConnectRequestListenersMap = new Map<number, () => void>();


export async function handleConnectCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    let messageWasDeleted = false;

    newConnectRequestListenersMap.get(chatId)?.();

    const connector = getConnector(chatId, () => {
        unsubscribe();
        newConnectRequestListenersMap.delete(chatId);
        deleteMessage();
    });

    await connector.restoreConnection();
    if (connector.connected) {
        const connectedName =
            (await getWalletInfo(connector.wallet!.device.appName))?.name ||
            connector.wallet!.device.appName;
        await bot.sendMessage(
            chatId,
            `You have already connect ${connectedName} wallet\nYour address: ${toUserFriendlyAddress(
                connector.wallet!.account.address,
                connector.wallet!.account.chain === CHAIN.TESTNET
            )}\n\n Disconnect wallet firstly to connect a new one`
        );

        return;
    }

    const unsubscribe = connector.onStatusChange(async wallet => {
        if (wallet) {
            await deleteMessage();

            const walletName =
                (await getWalletInfo(wallet.device.appName))?.name || wallet.device.appName;
            await bot.sendMessage(chatId, `${walletName} wallet connected successfully`);
            unsubscribe();
            newConnectRequestListenersMap.delete(chatId);
        }
    });

    const wallets = await getWallets();

    const link = connector.connect(wallets);
    const image = await QRCode.toBuffer(link);

    const keyboard = await buildUniversalKeyboard(link, wallets);

    const botMessage = await bot.sendPhoto(chatId, image, {
        reply_markup: {
            inline_keyboard: [keyboard]
        }
    });

    const deleteMessage = async (): Promise<void> => {
        if (!messageWasDeleted) {
            messageWasDeleted = true;
            await bot.deleteMessage(chatId, botMessage.message_id);
        }
    };

    newConnectRequestListenersMap.set(chatId, async () => {
        unsubscribe();

        await deleteMessage();

        newConnectRequestListenersMap.delete(chatId);
    });
}

export async function handleSendTXCommand(msg: TelegramBot.Message): Promise<void> {
    let ContractAddress: string = '';
    let WithdrawalAddress: string = '';
    let withdrawalAmount: string = '';

    const chatId = msg.chat.id;
    const connector = getConnector(chatId);

    await bot.sendMessage(
        chatId,
        `Do you want to send "Native" or "Jetton"?`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Native', callback_data: 'native' },
                        { text: 'Jetton', callback_data: 'jetton' }
                    ]
                ]
            }
        }
    );

    bot.once('callback_query', async (query) => {
        const callbackData = query.data;
        ContractAddress = process.env.Zeroaddress_TON as string;
        if (callbackData === 'jetton') {
            await bot.sendMessage(chatId, `Please input contract address`);
            bot.once('message', async (msg2: TelegramBot.Message) => {
                const message2: string = msg2.text as string;
                const isValid: boolean = await isValidTonAddress(message2);
                if (!isValid) {
                    await bot.sendMessage(chatId, `Incorrect Address Type : Not a TON contract address : ${message2}`);
                    return;
                }
                await bot.sendMessage(chatId, `Received contract address: ${message2}`);
                ContractAddress = message2;

                // 次のステップへ移行
                await requestWithdrawalAddress(chatId);
            });
        } else if(callbackData === 'native'){
            // Nativeの場合、直接次のステップへ
            await requestWithdrawalAddress(chatId);
        }
    });

    async function requestWithdrawalAddress(chatId: number) {
        await bot.sendMessage(chatId, `Please input withdrawal address`);
        bot.once('message', async (msg3: TelegramBot.Message) => {
            const message3: string = msg3.text as string;
            const isValid: boolean = await isValidTonAddress(message3);
            if (!isValid) {
                await bot.sendMessage(chatId, `Incorrect Address Type : Not a TON address : ${message3}`);
                return;
            }
            await bot.sendMessage(chatId, `Input withdrawal address: ${message3}`);
            WithdrawalAddress = message3;

            // 次のステップへ移行
            await requestWithdrawalAmount(chatId);
        });
    }

    async function requestWithdrawalAmount(chatId: number) {
        await bot.sendMessage(chatId, `Please input withdrawal amount`);
        bot.once('message', async (msg4: TelegramBot.Message) => {
            const message4: string = msg4.text as string;
            withdrawalAmount = message4;
            await bot.sendMessage(chatId, `Input withdrawal amount: ${message4}`);

            // 最終処理
            await finalizeTransaction(chatId);
        });
    }

    async function finalizeTransaction(chatId: number) {
        // 必要な最終処理をここに実装します
        await bot.sendMessage(
            chatId,
            `Transaction details: \nContract Address: ${ContractAddress}\nWithdrawal Address: ${WithdrawalAddress}\nWithdrawal Amount: ${withdrawalAmount} \n Is it okay to execute a withdraw transaction?`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'OK', callback_data: 'true' },
                            { text: 'Cancel', callback_data: 'false' }
                        ]
                    ]
                }
            }
        );
        //Final confirm
        bot.once('callback_query', async (query) => {
            const callbackData = query.data;
            
            if (callbackData === 'false') {
                await bot.sendMessage(chatId, `cancel transaction`);
                return;
            } else {
                // Nativeの場合、直接次のステップへ
                await ExecuteTransaction(chatId);
            }
        });
    }

    async function ExecuteTransaction(chatId: number) {
        // 実際のトランザクション送信処理などを行います
        await connector.restoreConnection();
        if (!connector.connected) {
            await bot.sendMessage(chatId, 'Please Connect wallet to send transaction \n Finish Process');
            return;
        }

        pTimeout(
            connector.sendTransaction({
                validUntil: Math.round(
                    (Date.now() + Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)) / 1000
                ),
                messages: [
                    {
                        amount: withdrawalAmount,
                        address: WithdrawalAddress
                    }
                ]
            }),
            Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)
        )
            .then(() => {
                bot.sendMessage(chatId, `Transaction sent successfully`);
            })
            .catch(e => {
                if (e === pTimeoutException) {
                    bot.sendMessage(chatId, `Transaction was not confirmed`);
                    return;
                }
    
                if (e instanceof UserRejectsError) {
                    bot.sendMessage(chatId, `You rejected the transaction`);
                    return;
                }
    
                bot.sendMessage(chatId, `Unknown error happened`);
            })
            .finally(() => connector.pauseConnection());
    
        let deeplink = '';
        const walletInfo = await getWalletInfo(connector.wallet!.device.appName);
        if (walletInfo) {
            deeplink = walletInfo.universalLink;
        }
    
        if (isTelegramUrl(deeplink)) {
            const url = new URL(deeplink);
            url.searchParams.append('startattach', 'tonconnect');
            deeplink = addTGReturnStrategy(url.toString(), process.env.TELEGRAM_BOT_LINK!);
        }
    
        await bot.sendMessage(
            chatId,
            `Open ${walletInfo?.name || connector.wallet!.device.appName} and confirm transaction`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: `Open ${walletInfo?.name || connector.wallet!.device.appName}`,
                                url: deeplink
                            }
                        ]
                    ]
                }
            }
        );
    }



    /*await connector.restoreConnection();
    if (!connector.connected) {
        await bot.sendMessage(chatId, 'Connect wallet to send transaction');
        return;
    }

    pTimeout(
        connector.sendTransaction({
            validUntil: Math.round(
                (Date.now() + Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)) / 1000
            ),
            messages: [
                {
                    amount: '1000000',
                    address: '0:0000000000000000000000000000000000000000000000000000000000000000'
                }
            ]
        }),
        Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)
    )
        .then(() => {
            bot.sendMessage(chatId, `Transaction sent successfully`);
        })
        .catch(e => {
            if (e === pTimeoutException) {
                bot.sendMessage(chatId, `Transaction was not confirmed`);
                return;
            }

            if (e instanceof UserRejectsError) {
                bot.sendMessage(chatId, `You rejected the transaction`);
                return;
            }

            bot.sendMessage(chatId, `Unknown error happened`);
        })
        .finally(() => connector.pauseConnection());

    let deeplink = '';
    const walletInfo = await getWalletInfo(connector.wallet!.device.appName);
    if (walletInfo) {
        deeplink = walletInfo.universalLink;
    }

    if (isTelegramUrl(deeplink)) {
        const url = new URL(deeplink);
        url.searchParams.append('startattach', 'tonconnect');
        deeplink = addTGReturnStrategy(url.toString(), process.env.TELEGRAM_BOT_LINK!);
    }

    await bot.sendMessage(
        chatId,
        `Open ${walletInfo?.name || connector.wallet!.device.appName} and confirm transaction`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: `Open ${walletInfo?.name || connector.wallet!.device.appName}`,
                            url: deeplink
                        }
                    ]
                ]
            }
        }
    );*/
}

/*Validation wallet address function*/
async function isValidTonAddress(address: string): Promise<boolean> {
    // confirm encoded by base64  
    const base64regex = /^[A-Za-z0-9-_]+$/;
    if (!base64regex.test(address)) {
        return false;
    }

    // Check address length (defalt 48)
    if (address.length !== Number(process.env.Default_Tonwallet_address as string)) {
        return false;
    }

    // Check if address starts with specified format
    const validPrefixes = ["EQ", "Ef", "UQ"];
    const prefix = address.substring(0, 2);
    if (!validPrefixes.includes(prefix)) {
        return false;
    }
    // ここまで全てのチェックを通過した場合、有効なTONアドレスと判断
    return true;
}


//Custome Part
// @dev For StonFi Swapping feture
/*export async function handleSwapTXCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const connector = getConnector(chatId);

    await connector.restoreConnection();
    if (!connector.connected) {
        await bot.sendMessage(chatId, 'Connect wallet to send transaction');
        return;
    }

    pTimeout(
        connector.sendTransaction({
            validUntil: Math.round(
                (Date.now() + Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)) / 1000
            ),
            messages: [
                {
                    amount: '1000000',
                    address: '0:0000000000000000000000000000000000000000000000000000000000000000'
                }
            ]
        }),
        Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)
    )
        .then(() => {
            bot.sendMessage(chatId, `Transaction sent successfully`);
        })
        .catch(e => {
            if (e === pTimeoutException) {
                bot.sendMessage(chatId, `Transaction was not confirmed`);
                return;
            }

            if (e instanceof UserRejectsError) {
                bot.sendMessage(chatId, `You rejected the transaction`);
                return;
            }

            bot.sendMessage(chatId, `Unknown error happened`);
        })
        .finally(() => connector.pauseConnection());

    let deeplink = '';
    const walletInfo = await getWalletInfo(connector.wallet!.device.appName);
    if (walletInfo) {
        deeplink = walletInfo.universalLink;
    }

    if (isTelegramUrl(deeplink)) {
        const url = new URL(deeplink);
        url.searchParams.append('startattach', 'tonconnect');
        deeplink = addTGReturnStrategy(url.toString(), process.env.TELEGRAM_BOT_LINK!);
    }

    await bot.sendMessage(
        chatId,
        `Open ${walletInfo?.name || connector.wallet!.device.appName} and confirm transaction`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: `Open ${walletInfo?.name || connector.wallet!.device.appName}`,
                            url: deeplink
                        }
                    ]
                ]
            }
        }
    );
}*/

export async function handleDisconnectCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const connector = getConnector(chatId);

    await connector.restoreConnection();
    if (!connector.connected) {
        await bot.sendMessage(chatId, "You didn't connect a wallet");
        return;
    }

    await connector.disconnect();

    await bot.sendMessage(chatId, 'Wallet has been disconnected');
}

export async function handleShowMyWalletCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const connector = getConnector(chatId);

    await connector.restoreConnection();
    if (!connector.connected) {
        await bot.sendMessage(chatId, "You didn't connect a wallet");
        return;
    }

    const walletName =
        (await getWalletInfo(connector.wallet!.device.appName))?.name ||
        connector.wallet!.device.appName;

    await bot.sendMessage(
        chatId,
        `Connected wallet: ${walletName}\nYour address: ${toUserFriendlyAddress(
            connector.wallet!.account.address,
            connector.wallet!.account.chain === CHAIN.TESTNET
        )}`
    );
}
