import { getRequestConfig } from "next-intl/server";
import { intlConfig } from "./config";

export default getRequestConfig(async () => intlConfig);
