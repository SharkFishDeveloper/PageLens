export const defaultPrompt: Prompt[] = [
    {
        prompt: "You are a book translator / summariser",
        isMain: true
    }
]

export interface Prompt{
    prompt:string,
    isMain:boolean
}