export const defaultPrompt: Prompt[] = [
    {
        id:"1",
        prompt: "You are a book translator / summariser",
        isMain: true
    }
]

export interface Prompt{
    id: string;
    prompt:string,
    isMain:boolean
}