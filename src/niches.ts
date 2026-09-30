import type { Niche } from "./types";

export const NICHES: Niche[] = [
  {
    id: "a1-fullstack-key",
    name: "Fullstack apps from scratch",
    queries: [
      `(fullstack OR "full stack" OR "full-stack") AND (React OR Java OR "Spring Boot") NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR designer OR "UI/UX" OR logo OR branding OR tester OR testing OR QA OR video OR unity OR "3d" OR solana OR solidity OR "smart contract" OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `(React OR Next OR "front-end" OR frontend) AND (Spring OR "Spring Boot" OR Java) AND (website OR app OR application OR platform OR dashboard OR "from scratch") NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR designer OR "UI/UX" OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [759, 2370, 2376],
  },
  {
    id: "a2-backend-rest",
    name: "Backend for existing frontend",
    queries: [
      `(React OR Next OR frontend) AND ("REST API" OR "Spring Boot" OR backend) AND (integrate OR build OR create OR develop OR "add") NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `("REST API" OR RESTful OR "Spring Boot" OR Spring) AND (Java OR React OR frontend OR web) NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR designer OR tester OR testing OR QA OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [2370, 2703, 759],
  },
  {
    id: "a3-admin-crud",
    name: "Admin panels and CRUD",
    queries: [
      `("admin panel" OR "admin dashboard" OR dashboard OR CRUD OR "data table") AND (React OR Spring OR "Spring Boot" OR fullstack OR "full stack") NOT (php OR laravel OR python OR django OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR designer OR "UI/UX" OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `(dashboard OR "admin panel" OR CRUD) AND (React OR TypeScript OR Java OR Spring) AND (API OR backend OR fullstack) NOT (php OR laravel OR python OR wordpress OR shopify OR designer OR tester OR testing OR QA OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [759, 2370, 607],
  },
  {
    id: "a4-react-dashboard",
    name: "React dashboards",
    queries: [
      `(React OR ReactJS) AND ("admin panel" OR "admin dashboard" OR dashboard OR CRUD OR "data table" OR analytics OR charts) NOT ("react native" OR flutter OR native OR php OR laravel OR python OR ruby OR rails OR wordpress OR shopify OR designer OR "UI/UX" OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `("admin panel" OR dashboard OR CRUD) AND (React OR TypeScript OR "front-end" OR frontend) NOT ("react native" OR flutter OR php OR wordpress OR python OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [759, 979],
  },
  {
    id: "a5-react-bugfix",
    name: "React bugfix urgent",
    queries: [
      `(React OR ReactJS OR Next OR NextJS) AND (bug OR fix OR debug OR error OR crash OR broken OR urgent OR "not working" OR troubleshoot OR "white screen") NOT ("react native" OR flutter OR native OR php OR python OR ruby OR rails OR wordpress OR shopify OR designer OR tester OR testing OR QA OR video OR unity OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `(React OR Next) AND (hotfix OR "console error" OR "build error" OR "blank page" OR glitch) NOT ("react native" OR flutter OR php OR python OR wordpress OR designer OR tester OR testing OR QA OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [759, 2376],
  },
  {
    id: "a6-figma-react",
    name: "Figma to React",
    queries: [
      `(Figma) AND ("to React" OR "pixel perfect" OR "pixel-perfect" OR implement OR component OR responsive) NOT (designer OR "UI/UX" OR logo OR branding OR wordpress OR webflow OR wix OR shopify OR "react native" OR flutter OR tester OR testing OR QA OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `(Figma OR XD OR PSD) AND (convert OR implement OR slice OR responsive OR markup) AND (React OR TypeScript OR JavaScript) NOT (designer OR "UI/UX" OR logo OR branding OR wordpress OR webflow OR wix OR shopify OR "react native" OR flutter OR tester OR testing OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [759, 979, 323],
  },
  {
    id: "a7-js-ts-migration",
    name: "JS to TypeScript migration",
    queries: [
      `(TypeScript OR typed OR "type safety") AND (React OR JavaScript OR migrate OR migration OR convert) NOT ("react native" OR flutter OR php OR python OR wordpress OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [979, 9],
  },
  {
    id: "a8-nextjs",
    name: "Next.js junior mid",
    queries: [
      `(Next OR NextJS OR "Next.js" OR "App Router") AND (React OR frontend OR page OR SSR) NOT ("react native" OR flutter OR native OR php OR python OR ruby OR rails OR wordpress OR shopify OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [2376, 759],
  },
  {
    id: "a9-landing",
    name: "Landing pages markup",
    queries: [
      `(website OR "landing page" OR "web page" OR "company website" OR "business website") AND (HTML OR CSS OR JavaScript OR markup OR layout OR responsive) NOT (wordpress OR webflow OR wix OR squarespace OR elementor OR shopify OR bubble OR softr OR carrd OR framer OR showit OR readymag OR gohighlevel OR opencart OR "react native" OR flutter OR php OR laravel OR designer OR "UI/UX" OR logo OR branding OR tester OR testing OR QA OR video OR unity OR "3d" OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `(website OR "landing page" OR site) AND (build OR develop OR create OR "from scratch" OR redesign) AND (HTML OR CSS OR JavaScript OR responsive) NOT (wordpress OR webflow OR wix OR squarespace OR elementor OR shopify OR bubble OR softr OR carrd OR framer OR showit OR readymag OR gohighlevel OR opencart OR "react native" OR flutter OR php OR designer OR "UI/UX" OR video OR tester OR testing OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [323, 1042, 9],
  },
  {
    id: "a10-css-fixes",
    name: "CSS fixes responsive",
    queries: [
      `(HTML OR CSS OR JavaScript OR responsive OR "mobile-friendly" OR "mobile friendly") AND (fix OR bug OR broken OR layout OR alignment OR styling OR overlap OR adapt) NOT (wordpress OR webflow OR wix OR squarespace OR elementor OR shopify OR php OR laravel OR "react native" OR flutter OR designer OR "UI/UX" OR video OR tester OR testing OR QA OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [1042, 323],
  },
  {
    id: "a11-spring-rest",
    name: "Spring Boot REST API",
    queries: [
      `(Java OR Spring OR "Spring Boot") AND ("REST API" OR RESTful OR backend OR "back-end") NOT (php OR python OR django OR ruby OR rails OR laravel OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR minecraft OR designer OR tester OR testing OR QA OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `("Spring Boot" OR Spring) AND (API OR microservice OR backend OR "back-end" OR PostgreSQL OR database) NOT (php OR python OR django OR ruby OR rails OR wordpress OR shopify OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer OR designer OR tester OR testing OR QA)`,
    ],
    jobs: [2370, 2703, 607],
  },
  {
    id: "a12-docker-deploy",
    name: "Docker deploy",
    queries: [
      `(Docker OR "docker-compose" OR containerize) AND (deploy OR deployment OR server OR VPS OR "set up" OR setup OR install) NOT (kubernetes OR helm OR jenkins OR terraform OR "CI/CD pipeline" OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
      `(deploy OR deployment) AND (Docker OR compose OR container) AND (server OR VPS OR hosting OR Linux) NOT (kubernetes OR helm OR jenkins OR terraform OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`,
    ],
    jobs: [1002],
  },
];
