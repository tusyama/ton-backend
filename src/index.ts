import express from "express";
import dotenv from "dotenv";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import TonWeb from "tonweb";
import cors from "cors";
import { Address, TonClient, beginCell, fromNano } from "@ton/ton";
import { ETHbridge, BSCbridge } from "./consts/bridges";
import { mainStakingPool } from "./consts/stakings";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));

const port = process.env.PORT || 3000;

async function getTONWebConnector() {
  const endpoint = await getHttpEndpoint();
  return new TonWeb(new TonWeb.HttpProvider(endpoint));
}
// TODO wrap these methods into route-controller-service layer model
app.get("/check-task/bridge", async (req, res) => {
  const { address: addressRaw, network: networkRaw } = req.query;

  if (!addressRaw || !networkRaw) {
    res.status(400).json({ error: "required: address, network" });
    return;
  }

  const bridges = {
    ETH: ETHbridge,
    BSC: BSCbridge,
  };

  const network = networkRaw.toString() as "ETH" | "BSC";
  const myAddressString = addressRaw.toString();
  const myAddress = Address.parse(myAddressString); // address that you want to fetch transactions from

  const bridgeAddress = bridges[network];

  if (!bridgeAddress) {
    res.status(400).json({ error: "wrong: network" });
    return;
  }

  try {
    const tonweb = await getTONWebConnector();
    const transactions = await tonweb.getTransactions(myAddressString, 99);
    if (transactions.length === 0) {
      res.json({ status: "waiting" });
      return;
    }

    const transaction = transactions.find(
      (tx: any) =>
        tx["in_msg"]["source"].toString() === bridgeAddress &&
        tx["in_msg"]["destination"].toString() === myAddress.toString()
    );

    if (!transaction) {
      res.json({ status: "waiting" });
      return;
    }
    res.json({ status: "done" });
    return;
  } catch (e) {
    res.status(400).json({ status: "error", message: "address isn't valid" });
  }
});

app.get("/check-task/balance", async (req, res) => {
  const { address } = req.query;
  if (!address) {
    res.status(400).json({ error: "'address' required" });
    return;
  }
  try {
    const tonweb = await getTONWebConnector();
    const balance = await tonweb.getBalance(address as string);

    res.json({ status: parseInt(balance) > 0 ? "done" : "waiting" });
    return;
  } catch (e) {
    res.status(400).json({ status: "error", message: "address isn't valid" });
  }
});

app.get("/check-task/staking", async (req, res) => {
  const { address } = req.query;
  if (!address) {
    res.status(400).json({ error: "'address' required" });
    return;
  }
  try {
    const tonweb = await getTONWebConnector();
    const transactions = await tonweb.getTransactions(address as string, 99);
    if (transactions.length === 0) {
      res.json({ status: "waiting" });
      return;
    }

    const transaction = transactions.find(
      (tx: any) => tx["in_msg"]["source"].toString() === mainStakingPool
    );
    if (!transaction) {
      res.json({ status: "waiting" });
      return;
    }
    res.json({ status: "done" });
    return;
  } catch (e) {
    res.status(400).json({ status: "error", message: "address isn't valid" });
  }
});

app.get("/parse-transactions", async (req, res) => {
  const { address } = req.query;
  if (!address) {
    res.status(400).json({ error: "need address" });
    return;
  }
  try {
    const client = new TonClient({
      endpoint: "https://toncenter.com/api/v2/jsonRPC",
      apiKey: "1b312c91c3b691255130350a49ac5a0742454725f910756aff94dfe44858388e",
    });
    const logs = [];

    const myAddress = Address.parse(address.toString()); // address that you want to fetch transactions from

    const transactions = await client.getTransactions(myAddress, {
      limit: 99,
    });

    function toObject(obj: any) {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          obj[key] = obj[key].toString();
        }
      }
      return JSON.parse(JSON.stringify(obj));
    }

    for (const tx of transactions) {
      const inMsg = tx.inMessage;

      if (inMsg?.info.type == "internal") {
        // we only process internal messages here because they are used the most
        // for external messages some of the fields are empty, but the main structure is similar
        const sender = inMsg?.info.src;
        const value = inMsg?.info.value.coins;

        const originalBody = inMsg?.body.beginParse();
        let body = originalBody.clone();
        if (body.remainingBits < 32) {
          // if body doesn't have opcode: it's a simple message without comment
          logs.push(`Simple transfer from ${sender} with value ${fromNano(value)} TON`);
        } else {
          const op = body.loadUint(32);
          if (op == 0) {
            // if opcode is 0: it's a simple message with comment
            const comment = body.loadStringTail();
            logs.push(
              `Simple transfer from ${sender} with value ${fromNano(
                value
              )} TON and comment: "${comment}"`
            );
          } else if (op == 0x7362d09c) {
            // if opcode is 0x7362d09c: it's a Jetton transfer notification

            body.skip(64); // skip query_id
            const jettonAmount = body.loadCoins();
            const jettonSender = body.loadAddressAny();
            const originalForwardPayload = body.loadBit() ? body.loadRef().beginParse() : body;
            let forwardPayload = originalForwardPayload.clone();

            // IMPORTANT: we have to verify the source of this message because it can be faked
            const runStack = (await client.runMethod(sender, "get_wallet_data")).stack;
            runStack.skip(2);
            const jettonMaster = runStack.readAddress();
            const jettonWallet = (
              await client.runMethod(jettonMaster, "get_wallet_address", [
                { type: "slice", cell: beginCell().storeAddress(myAddress).endCell() },
              ])
            ).stack.readAddress();
            if (!jettonWallet.equals(sender)) {
              // if sender is not our real JettonWallet: this message was faked
              logs.push(`FAKE Jetton transfer`);
              continue;
            }

            if (forwardPayload.remainingBits < 32) {
              // if forward payload doesn't have opcode: it's a simple Jetton transfer
              logs.push(
                `Jetton transfer from ${jettonSender} with value ${fromNano(jettonAmount)} Jetton`
              );
            } else {
              const forwardOp = forwardPayload.loadUint(32);
              if (forwardOp == 0) {
                // if forward payload opcode is 0: it's a simple Jetton transfer with comment
                const comment = forwardPayload.loadStringTail();
                logs.push(
                  `Jetton transfer from ${jettonSender} with value ${fromNano(
                    jettonAmount
                  )} Jetton and comment: "${comment}"`
                );
              } else {
                // if forward payload opcode is something else: it's some message with arbitrary structure
                // you may parse it manually if you know other opcodes or just print it as hex
                logs.push(
                  `Jetton transfer with unknown payload structure from ${jettonSender} with value ${fromNano(
                    jettonAmount
                  )} Jetton and payload: ${originalForwardPayload}`
                );
              }

              logs.push(`Jetton Master: ${jettonMaster}`);
            }
          } else if (op == 0x05138d91) {
            // if opcode is 0x05138d91: it's a NFT transfer notification

            body.skip(64); // skip query_id
            const prevOwner = body.loadAddress();
            const originalForwardPayload = body.loadBit() ? body.loadRef().beginParse() : body;
            let forwardPayload = originalForwardPayload.clone();

            // IMPORTANT: we have to verify the source of this message because it can be faked
            const runStack = (await client.runMethod(sender, "get_nft_data")).stack;
            runStack.skip(1);
            const index = runStack.readBigNumber();
            const collection = runStack.readAddress();
            const itemAddress = (
              await client.runMethod(collection, "get_nft_address_by_index", [
                { type: "int", value: index },
              ])
            ).stack.readAddress();

            if (!itemAddress.equals(sender)) {
              logs.push(`FAKE NFT Transfer`);
              continue;
            }

            if (forwardPayload.remainingBits < 32) {
              // if forward payload doesn't have opcode: it's a simple NFT transfer
              logs.push(`NFT transfer from ${prevOwner}`);
            } else {
              const forwardOp = forwardPayload.loadUint(32);
              if (forwardOp == 0) {
                // if forward payload opcode is 0: it's a simple NFT transfer with comment
                const comment = forwardPayload.loadStringTail();
                logs.push(`NFT transfer from ${prevOwner} with comment: "${comment}"`);
              } else {
                // if forward payload opcode is something else: it's some message with arbitrary structure
                // you may parse it manually if you know other opcodes or just print it as hex
                logs.push(
                  `NFT transfer with unknown payload structure from ${prevOwner} and payload: ${originalForwardPayload}`
                );
              }
            }

            logs.push(`NFT Item: ${itemAddress}`);
            logs.push(`NFT Collection: ${collection}`);
          } else {
            // if opcode is something else: it's some message with arbitrary structure
            // you may parse it manually if you know other opcodes or just print it as hex
            logs.push(
              `Message with unknown structure from ${sender} with value ${fromNano(
                value
              )} TON and body: ${originalBody}`
            );
          }
        }
      }
      logs.push(`Transaction Hash: ${tx.hash().toString("hex")}`);
      logs.push(`Transaction LT: ${tx.lt}`);
    }
    res.json({ status: "Ok", logs });
  } catch (error) {
    console.error({ error });
    res.status(400).json({ status: "error", message: "address isn't valid" });
  }
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
