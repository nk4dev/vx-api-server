import { Hono } from "hono";
import { ethers } from "ethers";

export const ethGasService = new Hono();

ethGasService.get("/gas-price", async (c) => {
    try {
        const provider = new ethers.providers.JsonRpcProvider("https://eth.llamarpc.com");
        const gasPrice = await provider.getGasPrice();
        const gasPriceGwei = ethers.utils.formatUnits(gasPrice, "gwei");
        return c.json({ gasPrice: gasPriceGwei });
    }
    catch (error) {
        return c.json({ error: 'Sorry. API is not working' }, 500);
    }
});